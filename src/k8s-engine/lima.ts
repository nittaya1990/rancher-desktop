// Kubernetes backend for macOS, based on Lima.

import { Console } from 'console';
import events from 'events';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import stream from 'stream';
import timers from 'timers';
import util from 'util';
import { ChildProcess, spawn as spawnWithSignal } from 'child_process';

import semver from 'semver';
import tar from 'tar';
import yaml from 'yaml';
import merge from 'lodash/merge';

import { Settings } from '@/config/settings';
import * as childProcess from '@/utils/childProcess';
import Logging from '@/utils/logging';
import paths from '@/utils/paths';
import resources from '@/resources';
import DEFAULT_CONFIG from '@/assets/lima-config.yaml';
import INSTALL_K3S_SCRIPT from '@/assets/scripts/install-k3s';
import SERVICE_K3S_SCRIPT from '@/assets/scripts/service-k3s';
import LOGROTATE_K3S_SCRIPT from '@/assets/scripts/logrotate-k3s';
import mainEvents from '@/main/mainEvents';
import UnixlikeIntegrations from '@/k8s-engine/unixlikeIntegrations';
import K3sHelper, { ShortVersion } from './k3sHelper';
import ProgressTracker from './progressTracker';
import * as K8s from './k8s';

/**
 * Enumeration for tracking what operation the backend is undergoing.
 */
enum Action {
  NONE = 'idle',
  STARTING = 'starting',
  STOPPING = 'stopping',
}

/**
 * Lima configuration
 */
type LimaConfiguration = {
  arch?: 'x86_64' | 'aarch64';
  images: {
    location: string;
    arch?: 'x86_64';
    digest?: string;
  }[];
  cpus?: number;
  memory?: number;
  disk?: number;
  mounts?: {
    location: string;
    writable?: boolean;
  }[];
  ssh: {
    localPort: number;
    loadDotSSHPubKeys?: boolean;
  }
  firmware?: {
    legacyBIOS?: boolean;
  }
  video?: {
    display?: string;
  }
  provision?: {
    mode: 'system' | 'user';
    script: string;
  }[]
  containerd?: {
    system?: boolean;
    user?: boolean;
  }
  probes?: {
    mode: 'readiness';
    description: string;
    script: string;
    hint: string;
  }[];

  // The rest of the keys are not used by lima, just state we keep with the VM.
  k3s?: {
    version: string;
  }
}

/**
 * One entry from `limactl list --json`
 */
interface LimaListResult {
  name: string;
  status: 'Broken' | 'Stopped' | 'Running';
  dir: string;
  arch: 'x86_64' | 'aarch64';
  sshLocalPort?: number;
  hostAgentPID?: number;
  qemuPID?: number;
  errors?: string[];
}

const console = new Console(Logging.lima.stream);
const MACHINE_NAME = '0';
const IMAGE_VERSION = '0.1.4';

function defined<T>(input: T | null | undefined): input is T {
  return input !== null && typeof input !== 'undefined';
}

export default class LimaBackend extends events.EventEmitter implements K8s.KubernetesBackend {
  constructor() {
    super();
    this.k3sHelper.on('versions-updated', () => this.emit('versions-updated'));
    this.k3sHelper.initialize();

    this.progressTracker = new ProgressTracker((progress) => {
      this.progress = progress;
      this.emit('progress');
    });

    if (!(process.env.NODE_ENV ?? '').includes('test')) {
      process.on('exit', () => {
        // Attempt to shut down any stray qemu processes.
        process.kill(0);
      });
    }
  }

  protected readonly CONFIG_PATH = path.join(paths.lima, '_config', `${ MACHINE_NAME }.yaml`);

  protected cfg: Settings['kubernetes'] | undefined;

  /** The version of Kubernetes currently running. */
  protected activeVersion: ShortVersion = '';

  /** The port Kubernetes is actively listening on. */
  protected currentPort = 0;

  /** The port the Kubernetes server _should_ listen on */
  #desiredPort = 6443;

  /** Helper object to manage available K3s versions. */
  protected k3sHelper = new K3sHelper();

  protected client: K8s.Client | null = null;

  /** Helper object to manage progress notificatinos. */
  protected progressTracker;

  /** Interval handle to update the progress. */
  // The return type is odd because TypeScript is pulling in some of the DOM
  // definitions here, which has an incompatible setInterval/clearInterval.
  protected progressInterval: ReturnType<typeof timers.setInterval> | undefined;

  /**
   * The current operation underway; used to avoid responding to state changes
   * when we're in the process of doing a different one.
   */
  protected currentAction: Action = Action.NONE;

  protected unixlikeIntegrations = new UnixlikeIntegrations();

  protected internalState: K8s.State = K8s.State.STOPPED;
  get state() {
    return this.internalState;
  }

  protected setState(state: K8s.State) {
    this.internalState = state;
    this.emit('state-changed', this.state);
    switch (this.state) {
    case K8s.State.STOPPING:
    case K8s.State.STOPPED:
    case K8s.State.ERROR:
      this.client?.destroy();
    }
  }

  progress: K8s.KubernetesProgress = { current: 0, max: 0 };

  /** Process for tailing logs */
  protected logProcess: childProcess.ChildProcess | null = null;

  get backend(): 'lima' {
    return 'lima';
  }

  get version(): ShortVersion {
    return this.activeVersion;
  }

  get availableVersions(): Promise<ShortVersion[]> {
    return this.k3sHelper.availableVersions;
  }

  get cpus(): Promise<number> {
    return (async() => {
      return (await this.currentConfig)?.cpus || 0;
    })();
  }

  get memory(): Promise<number> {
    return (async() => {
      return Math.round(((await this.currentConfig)?.memory || 0) / 1024 / 1024 / 1024);
    })();
  }

  get desiredPort() {
    return this.#desiredPort;
  }

  protected async ensureVirtualizationSupported() {
    const { stdout } = await childProcess.spawnFile(
      'sysctl', ['kern.hv_support'],
      { stdio: ['inherit', 'pipe', await Logging.k8s.fdStream] });

    if (!/:\s*1$/.test(stdout.trim())) {
      console.log(`Virtualization support error: got ${ stdout.trim() }`);
      throw new Error('Virtualization does not appear to be supported on your machine.');
    }
  }

  /** Get the IPv4 address of the VM, assuming it's already up */
  get ipAddress(): Promise<string | undefined> {
    return (async() => {
      // Get the routing map structure
      const state = await this.limaWithCapture('shell', '--workdir=.', MACHINE_NAME, 'cat', '/proc/net/fib_trie');

      // We look for the IP address by:
      // 1. Convert the structure (text) into lines.
      // 2. Look for lines followed by "/32 host LOCAL".
      //    This gives interface addresses.
      const lines = state
        .split(/\r?\n+/)
        .filter((_, i, array) => (array[i + 1] || '').includes('/32 host LOCAL'));
      // 3. Filter for lines with the shortest prefix; this is needed to reject
      //    the CNI interfaces.
      const lengths: [number, string][] = lines.map(line => [line.length - line.trimStart().length, line]);
      const minLength = Math.min(...lengths.map(([length]) => length));
      // 4. Drop the tree formatting ("    |-- ").  The result are IP addresses.
      // 5. Reject loopback addresses.
      const addresses = lengths
        .filter(([length]) => length === minLength)
        .map(([_, address]) => address.replace(/^\s+\|--/, '').trim())
        .filter(address => !address.startsWith('127.'));

      // Assume the first address is what we want, as the VM only has one
      // (non-loopback, non-CNI) interface.
      return addresses[0];
    })();
  }

  get desiredVersion(): Promise<ShortVersion> {
    return (async() => {
      const availableVersions = await this.k3sHelper.availableVersions;
      let version = this.cfg?.version || availableVersions[0];

      if (!version) {
        throw new Error('No version available');
      }

      if (!availableVersions.includes(version)) {
        console.error(`Could not use saved version ${ version }, not in ${ availableVersions }`);
        version = availableVersions[0];
      }

      return version;
    })();
  }

  getBackendInvalidReason(): Promise<K8s.KubernetesError | null> {
    return Promise.resolve(null);
  }

  /**
   * Check if the base (alpine) disk image is out of date; if yes, update it
   * without removing existing data.  This is only ever called from updateConfig
   * to ensure that the passed-in lima configuration is the one before we
   * overwrote it.
   *
   * This will stop the VM if necessary.
   */
  protected async updateBaseDisk(currentConfig: LimaConfiguration) {
    // Lima does not have natively have any support for this; we'll need to
    // reach into the configuration and:
    // 1) Figure out what the old base disk version is.
    // 2) Confirm that it's out of date.
    // 3) Change out the base disk as necessary.
    // Unfortunately, we don't have a version string anywhere _in_ the image, so
    // we will have to rely on the path in lima.yml instead.

    const images = currentConfig.images.map(i => path.basename(i.location));
    // We had a typo in the name of the image; it was "alpline" instead of "alpine".
    const versionMatch = images.map(i => /^alpl?ine-lima-v([0-9.]+)-/.exec(i)).find(defined);
    const existingVersion = semver.coerce(versionMatch ? versionMatch[1] : null);

    if (!existingVersion) {
      console.log(`Could not find base image version from ${ images }; skipping update of base images.`);

      return;
    }

    const versionComparison = semver.coerce(IMAGE_VERSION)?.compare(existingVersion);

    switch (versionComparison) {
    case undefined:
      // Could not parse desired image version
      console.log(`Error parsing desired image version ${ IMAGE_VERSION }`);

      return;
    case -1: {
      // existing version is newer
      const message = `
          This Rancher Desktop installation appears to be older than the version
          that created your existing Kubernetes cluster.  Please either update
          Rancher Desktop or reset Kubernetes and container images.`;

      console.log(`Base disk is ${ existingVersion }, newer than ${ IMAGE_VERSION } - aborting.`);
      throw new K8s.KubernetesError('Rancher Desktop Update Required', message.replace(/\s+/g, ' ').trim());
    }
    case 0:
      // The image is the same version as what we have
      return;
    case 1:
      // Need to update the image.
      break;
    default: {
      // Should never reach this.
      const message = `
        There was an error determining if your existing Rancher Desktop cluster
        needs to be updated.  Please reset Kubernetes and container images, or
        file an issue with your Rancher Desktop logs attached.`;

      console.log(`Invalid valid comparing ${ existingVersion } to desired ${ IMAGE_VERSION }: ${ JSON.stringify(versionComparison) }`);

      throw new K8s.KubernetesError('Fatal Error', message.replace(/\s+/g, ' ').trim());
    }
    }

    console.log(`Attempting to update base image from ${ existingVersion } to ${ IMAGE_VERSION }...`);

    if ((await this.status)?.status === 'Running') {
      // This shouldn't be possible (it should only be running if we started it
      // in the same Rancher Desktop instance); but just in case, we still stop
      // the VM anyway.
      await this.lima('stop', MACHINE_NAME);
    }

    const diskPath = path.join(paths.lima, MACHINE_NAME, 'basedisk');

    await fs.promises.copyFile(this.baseDiskImage, diskPath);
    // The config file will be updated in updateConfig() instead; no need to do it here.
    console.log(`Base image successfully updated.`);
  }

  protected get baseDiskImage() {
    return resources.get(os.platform(), `alpine-lima-v${ IMAGE_VERSION }-rd-3.13.5.iso`);
  }

  #sshPort = 0;
  get sshPort(): Promise<number> {
    return (async() => {
      if (this.#sshPort === 0) {
        if ((await this.status)?.status === 'Running') {
          // if the machine is already running, we can't change the port.
          const existingPort = (await this.currentConfig)?.ssh.localPort;

          if (existingPort) {
            this.#sshPort = existingPort;

            return existingPort;
          }
        }

        const server = net.createServer();

        await new Promise((resolve) => {
          server.once('listening', resolve);
          server.listen(0, '127.0.0.1');
        });
        this.#sshPort = (server.address() as net.AddressInfo).port;
        server.close();
      }

      return this.#sshPort;
    })();
  }

  /**
   * Update the Lima configuration.  This may stop the VM if the base disk image
   * needs to be changed.
   */
  protected async updateConfig(desiredVersion: ShortVersion) {
    const currentConfig = await this.currentConfig;
    const baseConfig: Partial<LimaConfiguration> = currentConfig || {};
    const config: LimaConfiguration = merge({}, baseConfig, DEFAULT_CONFIG as LimaConfiguration, {
      images:     [{
        location: this.baseDiskImage,
        arch:     'x86_64',
      }],
      cpus:   this.cfg?.numberCPUs || 4,
      memory: (this.cfg?.memoryInGB || 4) * 1024 * 1024 * 1024,
      mounts: [
        { location: path.join(paths.cache, 'k3s'), writable: false },
        { location: '~', writable: false },
        { location: '/tmp/rancher-desktop', writable: true },
      ],
      ssh:    { localPort: await this.sshPort },
      k3s:    { version: desiredVersion },
    });

    if (currentConfig) {
      // update existing configuration
      const configPath = path.join(paths.lima, MACHINE_NAME, 'lima.yaml');

      await this.progressTracker.action(
        'Updating outdated virtual machine',
        100,
        this.updateBaseDisk(currentConfig)
      );
      await fs.promises.writeFile(configPath, yaml.stringify(config), 'utf-8');
    } else {
      // new configuration
      await fs.promises.mkdir(path.dirname(this.CONFIG_PATH), { recursive: true });
      await fs.promises.writeFile(this.CONFIG_PATH, yaml.stringify(config));
      await childProcess.spawnFile('tmutil', ['addexclusion', paths.lima]);
    }
  }

  protected get currentConfig(): Promise<LimaConfiguration | undefined> {
    return (async() => {
      try {
        const configPath = path.join(paths.lima, MACHINE_NAME, 'lima.yaml');
        const configRaw = await fs.promises.readFile(configPath, 'utf-8');

        return yaml.parse(configRaw) as LimaConfiguration;
      } catch (ex) {
        if (ex.code === 'ENOENT') {
          return undefined;
        }
        throw ex;
      }
    })();
  }

  protected get limactl() {
    return resources.executable('lima/bin/limactl');
  }

  protected get limaEnv() {
    const binDir = resources.get(os.platform(), 'lima', 'bin');
    const pathList = (process.env.PATH || '').split(path.delimiter);
    const newPath = [binDir].concat(...pathList).filter(x => x);

    return {
      ...process.env, LIMA_HOME: paths.lima, PATH: newPath.join(path.delimiter)
    };
  }

  protected async lima(...args: string[]): Promise<void> {
    const stream = await Logging.lima.fdStream;

    try {
      await childProcess.spawnFile(this.limactl, args,
        { env: this.limaEnv, stdio: ['ignore', stream, stream] });
    } catch (ex) {
      console.error(`+ limactl ${ args.join(' ') }`);
      console.error(ex);
      throw ex;
    }
  }

  protected async limaWithCapture(...args: string[]): Promise<string> {
    const stream = await Logging.lima.fdStream;
    const { stdout } = await childProcess.spawnFile(this.limactl, args,
      { env: this.limaEnv, stdio: ['ignore', 'pipe', stream] });

    return stdout;
  }

  limaSpawn(args: string[]): ChildProcess {
    args = ['shell', '--workdir=.', MACHINE_NAME].concat(args);

    return spawnWithSignal(this.limactl, args, { env: this.limaEnv });
  }

  protected async ssh(...args: string[]): Promise<void> {
    await this.lima('shell', '--workdir=.', MACHINE_NAME, ...args);
  }

  /**
   * Get the current Lima VM status, or undefined if there was an error
   * (e.g. the machine is not registered).
   */
  protected get status(): Promise<LimaListResult | undefined> {
    return (async() => {
      try {
        const text = await this.limaWithCapture('list', '--json');
        const lines = text.split(/\r?\n/).filter(x => x.trim());
        const entries = lines.map(line => JSON.parse(line) as LimaListResult);

        return entries.find(entry => entry.name === MACHINE_NAME);
      } catch (ex) {
        console.error('Could not parse lima status, assuming machine is unavailable.');

        return undefined;
      }
    })();
  }

  protected get isRegistered(): Promise<boolean> {
    return this.status.then(defined);
  }

  /**
   * Install K3s into the VM for execution.
   * @param version The version to install.
   */
  protected async installK3s(version: ShortVersion) {
    const fullVersion = this.k3sHelper.fullVersion(version);
    const workdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rd-k3s-install-'));

    try {
      const scriptPath = path.join(workdir, 'install-k3s');

      await fs.promises.writeFile(scriptPath, INSTALL_K3S_SCRIPT, { encoding: 'utf-8' });
      await this.ssh('mkdir', '-p', 'bin');
      await this.lima('copy', scriptPath, `${ MACHINE_NAME }:bin/install-k3s`);
      await this.ssh('chmod', 'a+x', 'bin/install-k3s');
      await fs.promises.chmod(path.join(paths.cache, 'k3s', fullVersion, 'k3s'), 0o755);
      await this.ssh('sudo', 'bin/install-k3s', fullVersion, path.join(paths.cache, 'k3s'));
      await this.lima('copy', resources.get('scripts', 'profile'), `${ MACHINE_NAME }:~/.profile`);
    } finally {
      await fs.promises.rm(workdir, { recursive: true });
    }
  }

  /**
   * Write the openrc script for k3s.
   */
  protected async writeServiceScript() {
    const script = SERVICE_K3S_SCRIPT.replace(/@PORT@/g, `${ this.desiredPort }`).replace(/\r/g, '');
    const workdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rd-k3s-service-'));

    try {
      const scriptPath = path.join(workdir, 'service-k3s');

      await fs.promises.writeFile(scriptPath, script, { encoding: 'utf-8' });
      await this.lima('copy', scriptPath, `${ MACHINE_NAME }:service-k3s`);
      await this.ssh('chmod', 'a+x', 'service-k3s');
      await this.ssh('sudo', '/bin/mv', 'service-k3s', '/etc/init.d/k3s');

      const logrotatePath = path.join(workdir, 'logrotate-k3s');

      await fs.promises.writeFile(logrotatePath, LOGROTATE_K3S_SCRIPT, { encoding: 'utf-8' });
      await this.lima('copy', logrotatePath, `${ MACHINE_NAME }:logrotate-k3s`);
      await this.ssh('sudo', '/bin/mv', 'logrotate-k3s', '/etc/logrotate.d/k3s');
    } finally {
      await fs.promises.rm(workdir, { recursive: true });
    }
  }

  protected async installTrivy() {
    await this.lima('copy', resources.get('linux', 'bin', 'trivy'), `${ MACHINE_NAME }:./trivy`);
    await this.lima('copy', resources.get('templates', 'trivy.tpl'), `${ MACHINE_NAME }:./trivy.tpl`);
    await this.ssh('sudo', 'mv', './trivy', '/usr/local/bin/trivy');
    await this.ssh('sudo', 'mv', './trivy.tpl', '/var/lib/trivy.tpl');
  }

  protected async followLogs() {
    try {
      this.logProcess?.kill('SIGTERM');
    } catch (ex) { }
    this.logProcess = childProcess.spawn(
      this.limactl,
      ['shell', '--workdir=.', MACHINE_NAME,
        '/usr/bin/tail', '-n+1', '-F', '/var/log/k3s'],
      {
        env:   this.limaEnv,
        stdio: ['ignore', await Logging.k3s.fdStream, await Logging.k3s.fdStream],
      },
    );
    this.logProcess.on('exit', (status, signal) => {
      this.logProcess = null;
      if (![Action.STARTING, Action.NONE].includes(this.currentAction)) {
        // Allow the log process to exit if we're stopping
        return;
      }
      if (![K8s.State.STARTING, K8s.State.STARTED].includes(this.state)) {
        // Allow the log process to exit if we're not active.
        return;
      }
      console.log(`Log process exited with ${ status }/${ signal }, restarting...`);
      setTimeout(this.followLogs.bind(this), 1_000);
    });
  }

  protected async deleteIncompatibleData(isDowngrade: boolean) {
    if (isDowngrade) {
      await this.progressTracker.action(
        'Deleting incompatible Kubernetes state',
        100,
        this.k3sHelper.deleteKubeState((...args: string[]) => this.ssh('sudo', ...args)));
    }
  }

  /**
   * Start the VM.  If the machine is already started, this does nothing.
   * Note that this does not start k3s.
   * @precondtion The VM configuration is correct.
   */
  protected async startVM() {
    await this.progressTracker.action('Starting virtual machine', 100, async() => {
      try {
        await this.lima('start', '--tty=false', await this.isRegistered ? MACHINE_NAME : this.CONFIG_PATH);
      } finally {
        // Symlink the logs (especially if start failed) so the users can find them
        const machineDir = path.join(paths.lima, MACHINE_NAME);

        // Start the process, but ignore the result.
        fs.promises.readdir(machineDir)
          .then(filenames => filenames.filter(x => x.endsWith('.log'))
            .forEach(filename => fs.promises.symlink(
              path.join(machineDir, filename),
              path.join(paths.logs, `lima.${ filename }`))
              .catch(() => { })));
      }
    });
  }

  async start(config: { version: string; memoryInGB: number; numberCPUs: number; port: number; }): Promise<void> {
    this.cfg = config;
    const desiredShortVersion = await this.desiredVersion;
    const previousVersion = (await this.currentConfig)?.k3s?.version;
    const isDowngrade = previousVersion ? semver.gt(previousVersion, desiredShortVersion) : false;

    this.#desiredPort = config.port;
    this.setState(K8s.State.STARTING);
    this.currentAction = Action.STARTING;

    await this.progressTracker.action('Starting kubernetes', 10, async() => {
      try {
        if (this.progressInterval) {
          timers.clearInterval(this.progressInterval);
        }
        this.progressInterval = timers.setInterval(() => {
          const statuses = [
            this.k3sHelper.progress.checksum,
            this.k3sHelper.progress.exe,
            this.k3sHelper.progress.images,
          ];
          const sum = (key: 'current' | 'max') => {
            return statuses.reduce((v, c) => v + c[key], 0);
          };

          this.progressTracker.numeric('Downloading Kubernetes components', sum('current'), sum('max'));
        }, 250);

        await Promise.all([
          this.progressTracker.action('Checking k3s images', 100, this.k3sHelper.ensureK3sImages(desiredShortVersion)),
          this.progressTracker.action('Ensuring virtualization is supported', 50, this.ensureVirtualizationSupported()),
          this.progressTracker.action('Updating cluster configuration', 50, this.updateConfig(desiredShortVersion)),
        ]);

        if (this.currentAction !== Action.STARTING) {
        // User aborted before we finished
          return;
        }

        // We have no good estimate for the rest of the steps, go indeterminate.
        timers.clearInterval(this.progressInterval);
        this.progressInterval = undefined;

        if ((await this.status)?.status === 'Running') {
          await this.progressTracker.action('Stopping existing instance', 100, async() => {
            await this.ssh('sudo', '/sbin/rc-service', 'k3s', 'stop');
            if (isDowngrade) {
              // If we're downgrading, stop the VM (and start it again immediately),
              // to ensure there are no containers running (so we can delete files).
              await this.lima('stop', MACHINE_NAME);
            }
          });
        }

        // Start the VM; if it's already running, this does nothing.
        await this.startVM();

        await this.deleteIncompatibleData(isDowngrade);
        await Promise.all([
          this.progressTracker.action('Installing k3s', 50, async() => {
            await this.installK3s(desiredShortVersion);
            await this.writeServiceScript();
          }),
          this.progressTracker.action('Installing image scanner', 50, this.installTrivy()),
          this.progressTracker.action('Installing CA certificates', 50, this.installCACerts()),
        ]);

        if (this.currentAction !== Action.STARTING) {
        // User aborted
          return;
        }

        await this.progressTracker.action('Starting k3s', 100, async() => {
          await this.ssh('sudo', '/sbin/rc-service', '--ifnotstarted', 'k3s', 'start');
          await this.followLogs();
        });

        await this.progressTracker.action(
          'Waiting for Kubernetes API',
          100,
          async() => {
            await this.k3sHelper.waitForServerReady(() => Promise.resolve('127.0.0.1'), this.#desiredPort);
            while (true) {
              if (this.currentAction !== Action.STARTING) {
              // User aborted
                return;
              }
              try {
                await childProcess.spawnFile(this.limactl,
                  ['shell', '--workdir=.', MACHINE_NAME, 'ls', '/etc/rancher/k3s/k3s.yaml'],
                  { env: this.limaEnv, stdio: 'ignore' });
                break;
              } catch (ex) {
                console.log('Could not read k3s.yaml; retrying...');
                await util.promisify(setTimeout)(1_000);
              }
            }
            console.debug('/etc/rancher/k3s/k3s.yaml is ready.');
          }
        );
        this.setState(K8s.State.VM_STARTED);
        await this.progressTracker.action(
          'Updating kubeconfig',
          50,
          this.k3sHelper.updateKubeconfig(
            () => this.limaWithCapture('shell', '--workdir=.', MACHINE_NAME, 'sudo', 'cat', '/etc/rancher/k3s/k3s.yaml')));
        await this.progressTracker.action(
          'Waiting for services',
          50,
          async() => {
            this.client = new K8s.Client();
            await this.client.waitForServiceWatcher();
            this.client.on('service-changed', (services) => {
              this.emit('service-changed', services);
            });
          }
        );

        this.activeVersion = desiredShortVersion;
        this.currentPort = this.#desiredPort;
        this.emit('current-port-changed', this.currentPort);
        // Trigger kuberlr to ensure there's a compatible version of kubectl in place for the users
        // rancher-desktop mostly uses the K8s API instead of kubectl, so we need to invoke kubectl
        // to nudge kuberlr
        await childProcess.spawnFile(resources.executable('kubectl'),
          ['--context', 'rancher-desktop', 'cluster-info'],
          { stdio: ['inherit', await Logging.k8s.fdStream, await Logging.k8s.fdStream] });

        await this.progressTracker.action(
          'Waiting for nodes',
          100,
          this.client?.waitForReadyNodes() ?? Promise.reject(new Error('No client')));

        this.setState(K8s.State.STARTED);
      } catch (err) {
        console.error('Error starting lima:', err);
        this.setState(K8s.State.ERROR);
        throw err;
      } finally {
        this.currentAction = Action.NONE;
      }
    });
  }

  protected async installCACerts(): Promise<void> {
    const certs: (string | Buffer)[] = await new Promise((resolve) => {
      mainEvents.once('cert-ca-certificates', resolve);
      mainEvents.emit('cert-get-ca-certificates');
    });

    const workdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rd-ca-'));

    try {
      await this.ssh('sudo', '/bin/sh', '-c', 'rm -f /usr/local/share/ca-certificates/rd-*.crt');

      await Promise.all(certs.map((cert, index) => {
        return util.promisify(stream.pipeline)(
          stream.Readable.from(cert),
          fs.createWriteStream(path.join(workdir, `rd-${ index }.crt`), { mode: 0o600 }),
        );
      }));
      await tar.create({
        cwd: workdir, file: path.join(workdir, 'certs.tar'), portable: true
      }, Object.keys(certs).map(i => `rd-${ i }.crt`));
      await this.lima('copy', path.join(workdir, 'certs.tar'), `${ MACHINE_NAME }:/tmp/certs.tar`);
      await this.ssh('sudo', 'tar', 'xf', '/tmp/certs.tar', '-C', '/usr/local/share/ca-certificates/');
    } finally {
      await fs.promises.rmdir(workdir, { recursive: true });
    }
    await this.ssh('sudo', 'update-ca-certificates');
  }

  async stop(): Promise<void> {
    // When we manually call stop, the subprocess will terminate, which will
    // cause stop to get called again.  Prevent the re-entrancy.
    // If we're in the middle of starting, also ignore the call to stop (from
    // the process terminating), as we do not want to shut down the VM in that
    // case.
    if (this.currentAction !== Action.NONE) {
      return;
    }
    this.currentAction = Action.STOPPING;
    await this.progressTracker.action('Stopping Kubernetes', 10, async() => {
      try {
        this.setState(K8s.State.STOPPING);

        const status = await this.status;

        if (defined(status) && status.status === 'Running') {
          await this.ssh('sudo', '/sbin/rc-service', 'k3s', 'stop');
          await this.lima('stop', MACHINE_NAME);
        }
        this.setState(K8s.State.STOPPED);
      } catch (ex) {
        this.setState(K8s.State.ERROR);
        throw ex;
      } finally {
        this.currentAction = Action.NONE;
      }
    });
  }

  async del(): Promise<void> {
    try {
      if (await this.isRegistered) {
        await this.stop();
        await this.progressTracker.action(
          'Deleting Kubernetes VM',
          10,
          this.lima('delete', MACHINE_NAME));
      }
    } catch (ex) {
      this.setState(K8s.State.ERROR);
      throw ex;
    }

    this.cfg = undefined;
  }

  async reset(config: Settings['kubernetes']): Promise<void> {
    await this.progressTracker.action('Resetting Kubernetes', 5, async() => {
      await this.stop();
      // Start the VM, so that we can delete files.
      await this.startVM();
      await this.k3sHelper.deleteKubeState(
        (...args: string[]) => this.ssh('sudo', ...args));
      await this.start(config);
    });
  }

  async factoryReset(): Promise<void> {
    await this.del();
    await Promise.all([paths.cache, paths.lima, paths.config, paths.logs]
      .map(p => fs.promises.rmdir(p, { recursive: true })));
  }

  async requiresRestartReasons(): Promise<Record<string, [any, any] | []>> {
    if (this.currentAction !== Action.NONE || this.internalState === K8s.State.ERROR) {
      // If we're in the middle of starting or stopping, we don't need to restart.
      // If we're in an error state, differences between current and desired could be meaningless
      return {};
    }

    const currentConfig = await this.currentConfig;

    const results: Record<string, [any, any] | []> = {};
    const cmp = (key: string, actual: number, desired: number) => {
      if (typeof actual === 'undefined') {
        results[key] = [];
      } else {
        results[key] = actual === desired ? [] : [actual, desired];
      }
    };

    if (!currentConfig || !this.cfg) {
      return {}; // No need to restart if nothing exists
    }
    const GiB = 1024 * 1024 * 1024;

    cmp('cpu', currentConfig.cpus || 4, this.cfg.numberCPUs);
    cmp('memory', Math.round((currentConfig.memory || 4 * GiB) / GiB), this.cfg.memoryInGB);
    console.log(`Checking port: ${ JSON.stringify({ current: this.currentPort, config: this.cfg.port }) }`);
    cmp('port', this.currentPort, this.cfg.port);

    return results;
  }

  listServices(namespace?: string): K8s.ServiceEntry[] {
    return this.client?.listServices(namespace) || [];
  }

  async isServiceReady(namespace: string, service: string): Promise<boolean> {
    return (await this.client?.isServiceReady(namespace, service)) || false;
  }

  get portForwarder() {
    return null;
  }

  async listIntegrations(): Promise<Record<string, boolean | string>> {
    return await this.unixlikeIntegrations.listIntegrations();
  }

  listIntegrationWarnings(): void {
    this.unixlikeIntegrations.listIntegrationWarnings();
  }

  async setIntegration(linkPath: string, state: boolean): Promise<string | undefined> {
    return await this.unixlikeIntegrations.setIntegration(linkPath, state);
  }
}
