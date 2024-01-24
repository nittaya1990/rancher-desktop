import fs from 'fs';
import os from 'os';
import path from 'path';

import { findHomeDir } from '@kubernetes/client-node';

import K3sHelper from '@pkg/backend/k3sHelper';
import { State } from '@pkg/backend/k8s';
import { Settings, ContainerEngine } from '@pkg/config/settings';
import { runInDebugMode } from '@pkg/config/settingsImpl';
import type { IntegrationManager } from '@pkg/integrations/integrationManager';
import mainEvents from '@pkg/main/mainEvents';
import BackgroundProcess from '@pkg/utils/backgroundProcess';
import { spawn, spawnFile } from '@pkg/utils/childProcess';
import clone from '@pkg/utils/clone';
import Logging from '@pkg/utils/logging';
import paths from '@pkg/utils/paths';
import { executable } from '@pkg/utils/resources';
import { defined, RecursivePartial } from '@pkg/utils/typeUtils';

const console = Logging.integrations;

/**
 * A list of distributions in which we should never attempt to integrate with.
 */
const DISTRO_BLACKLIST = [
  'rancher-desktop', // That's ourselves
  'rancher-desktop-data', // Another internal distro
  'docker-desktop', // Not meant for interactive use
  'docker-desktop-data', // Not meant for interactive use
];

/**
 * Represents a WSL distro, as output by `wsl.exe --list --verbose`.
 */
export class WSLDistro {
  name: string;
  version: number;

  constructor(name: string, version: number) {
    this.name = name;
    if (![1, 2].includes(version)) {
      throw new Error(`version "${ version }" is not recognized by Rancher Desktop`);
    }
    this.version = version;
  }
}

/**
 * WindowsIntegrationManager manages various integrations on Windows, for both
 * the Win32 host, as well as for each (foreign) WSL distribution.
 * This includes:
 * - Docker socket forwarding.
 * - Kubeconfig.
 * - docker CLI plugin executables (WSL distributions only).
 */
export default class WindowsIntegrationManager implements IntegrationManager {
  /** A snapshot of the application-wide settings. */
  protected settings: RecursivePartial<Settings> = {};

  /** Background processes for docker socket forwarding, per WSL distribution. */
  protected distroSocketProxyProcesses: Record<string, BackgroundProcess> = {};

  /** Background process for docker socket forwarding to the Windows host. */
  protected windowsSocketProxyProcess: BackgroundProcess;

  /** Whether integrations as a whole are enabled. */
  protected enforcing = false;

  /** Whether the backend is in a state where the processes should run. */
  protected backendReady = false;

  /** Set when we're about to quit. */
  protected quitting = false;

  /** Extra debugging arguments for wsl-helper. */
  protected wslHelperDebugArgs: string[] = [];

  constructor() {
    mainEvents.on('settings-update', (settings) => {
      this.wslHelperDebugArgs = runInDebugMode(settings.application.debug) ? ['--verbose'] : [];
      this.settings = clone(settings);
      this.sync();
    });
    mainEvents.on('k8s-check-state', (mgr) => {
      this.backendReady = [State.STARTED, State.STARTING, State.DISABLED].includes(mgr.state);
      this.sync();
    });
    mainEvents.handle('shutdown-integrations', async() => {
      this.quitting = true;
      await Promise.all(Object.values(this.distroSocketProxyProcesses).map(p => p.stop()));
    });
    this.windowsSocketProxyProcess = new BackgroundProcess(
      'Win32 socket proxy',
      {
        spawn: async() => {
          const stream = await Logging['wsl-helper'].fdStream;

          console.debug('Spawning Windows docker proxy');

          return spawn(
            executable('wsl-helper'),
            ['docker-proxy', 'serve', ...this.wslHelperDebugArgs], {
              stdio:       ['ignore', stream, stream],
              windowsHide: true,
            });
        },
      });

    // Trigger a settings-update.
    mainEvents.emit('settings-write', {});
  }

  async enforce(): Promise<void> {
    this.enforcing = true;
    await this.sync();
  }

  async remove(): Promise<void> {
    this.enforcing = false;
    await this.sync();
  }

  async sync(): Promise<void> {
    try {
      const kubeconfigPath = await K3sHelper.findKubeConfigToUpdate('rancher-desktop');

      await Promise.all([
        this.syncHostSocketProxy(),
        this.syncHostDockerPlugins(),
        this.syncHostFile(),
        ...(await this.supportedDistros).map(distro => this.syncDistro(distro.name, kubeconfigPath)),
      ]);
    } catch (ex) {
      console.error(`Integration sync: Error: ${ ex }`);
    } finally {
      mainEvents.emit('integration-update', await this.listIntegrations());
    }
  }

  async syncDistro(distro: string, kubeconfigPath: string): Promise<void> {
    let state = this.settings.WSL?.integrations?.[distro] === true;

    console.debug(`Integration sync: ${ distro } -> ${ state }`);
    try {
      await Promise.all([
        this.syncDistroSocketProxy(distro, state),
        this.syncDistroDockerPlugins(distro, state),
        this.syncDistroKubeconfig(distro, kubeconfigPath, state),
      ]);
    } catch (ex) {
      console.error(`Failed to sync integration for ${ distro }: ${ ex }`);
      mainEvents.emit('settings-write', { WSL: { integrations: { [distro]: false } } });
      state = false;
    } finally {
      await this.markIntegration(distro, state);
    }
  }

  #wslExe = '';
  /**
   * The path to the wsl.exe executable.
   *
   * @note This is memoized.
   */
  protected get wslExe(): Promise<string> {
    if (this.#wslExe) {
      return Promise.resolve(this.#wslExe);
    }

    if (process.env.RD_TEST_WSL_EXE) {
      // Running under test; use the alternate executable.
      return Promise.resolve(process.env.RD_TEST_WSL_EXE);
    }

    const wslExe = path.join(process.env.SystemRoot ?? '', 'system32', 'wsl.exe');

    return new Promise((resolve, reject) => {
      fs.promises.access(wslExe, fs.constants.X_OK).then(() => {
        this.#wslExe = wslExe;
        resolve(wslExe);
      }).catch(reject);
    });
  }

  /**
   * Execute the given command line in the given WSL distribution.
   * Output is logged to the log file.
   */
  protected async execCommand(opts: {distro?: string, encoding?:BufferEncoding, root?: boolean, env?: Record<string, string>}, ...command: string[]):Promise<void> {
    const logStream = opts.distro ? Logging[`wsl-helper.${ opts.distro }`] : console;
    const args = [];

    if (opts.distro) {
      args.push('--distribution', opts.distro);
      if (opts.root) {
        args.push('--user', 'root');
      }
      args.push('--exec');
    }
    args.push(...command);
    console.debug(`Running ${ await this.wslExe } ${ args.join(' ') }`);

    await spawnFile(
      await this.wslExe,
      args,
      {
        env:         opts.env,
        encoding:    opts.encoding ?? 'utf-8',
        stdio:       ['ignore', logStream, logStream],
        windowsHide: true,
      },
    );
  }

  /**
   * Runs the `wsl.exe` command, either on the host or in a specified
   * WSL distro. Returns whatever it prints to stdout, and logs whatever
   * it prints to stderr.
   */
  protected async captureCommand(opts: {distro?: string, encoding?: BufferEncoding, env?: Record<string, string>}, ...command: string[]):Promise<string> {
    const logStream = opts.distro ? Logging[`wsl-helper.${ opts.distro }`] : console;
    const args = [];

    if (opts.distro) {
      args.push('--distribution', opts.distro, '--exec');
    }
    args.push(...command);
    console.debug(`Running ${ await this.wslExe } ${ args.join(' ') }`);

    const { stdout } = await spawnFile(
      await this.wslExe,
      args,
      {
        env:         opts.env,
        encoding:    opts.encoding ?? 'utf-8',
        stdio:       ['ignore', 'pipe', logStream],
        windowsHide: true,
      },
    );

    return stdout;
  }

  /**
   * Return the Linux path to the WSL helper executable.
   */
  protected async getLinuxToolPath(distro: string, tool: string): Promise<string> {
    // We need to get the Linux path to our helper executable; it is easier to
    // just get WSL to do the transformation for us.

    const logStream = Logging[`wsl-helper.${ distro }`];
    const { stdout } = await spawnFile(
      await this.wslExe,
      ['--distribution', distro, '--exec', '/bin/wslpath', '-a', '-u', tool],
      { stdio: ['ignore', 'pipe', logStream] },
    );

    return stdout.trim();
  }

  protected async syncHostSocketProxy(): Promise<void> {
    const reason = this.dockerSocketProxyReason;

    console.debug(`Syncing Win32 socket proxy: ${ reason ? `should not run (${ reason })` : 'should run' }`);
    if (!reason) {
      this.windowsSocketProxyProcess.start();
    } else {
      await this.windowsSocketProxyProcess.stop();
    }
  }

  /**
   * Get the reason that the docker socket should not run; if it _should_ run,
   * returns undefined.
   */
  get dockerSocketProxyReason(): string | undefined {
    if (this.quitting) {
      return 'quitting Rancher Desktop';
    } else if (!this.enforcing) {
      return 'not enforcing';
    } else if (!this.backendReady) {
      return 'backend not ready';
    } else if (this.settings.containerEngine?.name !== ContainerEngine.MOBY) {
      return `unsupported container engine ${ this.settings.containerEngine?.name }`;
    }
  }

  /**
   * syncDistroSocketProxy ensures that the background process for the given
   * distribution is started or stopped, as desired.
   * @param distro The distribution to manage.
   * @param state Whether integration is enabled for the given distro.
   * @note this function must not throw.
   */
  protected async syncDistroSocketProxy(distro: string, state: boolean) {
    try {
      const shouldRun = state && !this.dockerSocketProxyReason;

      console.debug(`Syncing ${ distro } socket proxy: ${ shouldRun ? 'should' : 'should not' } run.`);
      if (shouldRun) {
        const linuxExecutable = await this.getLinuxToolPath(distro, executable('wsl-helper-linux'));
        const logStream = Logging[`wsl-helper.${ distro }`];

        this.distroSocketProxyProcesses[distro] ??= new BackgroundProcess(
          `${ distro } socket proxy`,
          {
            spawn: async() => {
              return spawn(await this.wslExe,
                ['--distribution', distro, '--user', 'root', '--exec', linuxExecutable,
                  'docker-proxy', 'serve', ...this.wslHelperDebugArgs],
                {
                  stdio:       ['ignore', await logStream.fdStream, await logStream.fdStream],
                  windowsHide: true,
                },
              );
            },
            destroy: async(child) => {
              child?.kill('SIGTERM');
              // Ensure we kill the WSL-side process; sometimes things can get out
              // of sync.
              await this.execCommand({ distro, root: true },
                linuxExecutable, 'docker-proxy', 'kill', ...this.wslHelperDebugArgs);
            },
          });
        this.distroSocketProxyProcesses[distro].start();
      } else {
        await this.distroSocketProxyProcesses[distro]?.stop();
        if (!(distro in (this.settings.WSL?.integrations ?? {}))) {
          delete this.distroSocketProxyProcesses[distro];
        }
      }
    } catch (error) {
      console.error(`Error syncing ${ distro } distro socket proxy: ${ error }`);
    }
  }

  protected async syncHostDockerPlugins() {
    const pluginNames = await this.getHostDockerCliPluginNames();

    await Promise.all(pluginNames.map(name => this.syncHostDockerPlugin(name)));
  }

  protected async getWslDockerCliPluginNames(): Promise<string[]> {
    const resourcesBinDir = path.join(paths.resources, 'linux', 'bin');

    return (await fs.promises.readdir(resourcesBinDir)).filter((name) => {
      return name.startsWith('docker-') && !name.startsWith('docker-credential-');
    });
  }

  protected async getHostDockerCliPluginNames(): Promise<string[]> {
    const resourcesBinDir = path.join(paths.resources, os.platform(), 'bin');

    const pluginNamesWithExe = (await fs.promises.readdir(resourcesBinDir)).filter((name) => {
      return name.startsWith('docker-') && !name.startsWith('docker-credential-');
    });

    return pluginNamesWithExe.map(pluginName => pluginName.replace(/\.exe$/, ''));
  }

  protected async syncHostDockerPlugin(pluginName: string) {
    const homeDir = findHomeDir();

    if (!homeDir) {
      throw new Error("Can't find home directory");
    }
    const cliDir = path.join(homeDir, '.docker', 'cli-plugins');
    const srcPath = executable(pluginName as any); // It's an executable in `bin`
    const cliPath = path.join(cliDir, path.basename(srcPath));

    console.debug(`Syncing host ${ pluginName }: ${ srcPath } -> ${ cliPath }`);
    await fs.promises.mkdir(cliDir, { recursive: true });
    try {
      await fs.promises.copyFile(
        srcPath, cliPath,
        fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
    } catch (error: any) {
      if (error?.code !== 'EEXIST') {
        console.error(`Failed to copy file ${ srcPath } to ${ cliPath }`, error);
      }
    }
  }

  protected async syncDistroDockerPlugins(distro: string, state: boolean): Promise<void> {
    const names = await this.getWslDockerCliPluginNames();

    await Promise.all(names.map(name => this.syncDistroDockerPlugin(distro, name, state)));
  }

  /**
   * syncDistroDockerPlugin ensures that a plugin is accessible in the given distro.
   * @param distro The distribution to manage.
   * @param pluginName The plugin to validate.
   * @param state Whether the plugin should be exposed.
   * @note this function must not throw.
   */
  protected async syncDistroDockerPlugin(distro: string, pluginName: string, state: boolean) {
    try {
      const srcPath = await this.getLinuxToolPath(distro,
        path.join(paths.resources, 'linux', 'bin', pluginName));
      const wslHelper = await this.getLinuxToolPath(distro, executable('wsl-helper-linux'));

      console.debug(`Syncing docker plugin ${ pluginName } for distribution ${ distro }: ${ state }`);
      await this.execCommand({ distro }, wslHelper, 'wsl', 'integration', 'docker-plugin', `--plugin=${ srcPath }`, `--state=${ state }`);
    } catch (error) {
      console.error(`Failed to sync ${ distro } docker plugin ${ pluginName }: ${ error }`.trim());
    }
  }

  protected async syncHostFile() {
    await Promise.all(
      (await this.supportedDistros).map((distro) => {
        return this.updateHostsFile(distro.name);
      }),
    );
  }

  protected async updateHostsFile(distro: string) {
    const entry = '192.168.1.2 gateway.rancher-desktop.internal';

    try {
      console.debug(`Update ${ distro } host file`);
      if (this.settings.experimental?.virtualMachine?.networkingTunnel) {
        await this.execCommand(
          { distro, root: true },
          await this.getLinuxToolPath(distro, executable('wsl-helper-linux')),
          'update-host',
          `--entries=${ entry }`,
        );
      } else {
        await this.execCommand(
          { distro, root: true },
          await this.getLinuxToolPath(distro, executable('wsl-helper-linux')),
          'update-host',
          `--remove`,
        );
      }
    } catch (error: any) {
      console.error(`Could not update ${ distro } host file`, error);
    }
  }

  protected async syncDistroKubeconfig(distro: string, kubeconfigPath: string, state: boolean) {
    const rdNetworking = this.settings.experimental?.virtualMachine?.networkingTunnel === true;

    try {
      console.debug(`Syncing ${ distro } kubeconfig`);
      await this.execCommand(
        {
          distro,
          env: {
            ...process.env,
            KUBECONFIG: kubeconfigPath,
            WSLENV:     `${ process.env.WSLENV }:KUBECONFIG/up`,
          },
        },
        await this.getLinuxToolPath(distro, executable('wsl-helper-linux')),
        'kubeconfig',
        `--enable=${ state && this.settings.kubernetes?.enabled }`,
        `--rd-networking=${ rdNetworking }`,
      );
    } catch (error: any) {
      if (typeof error?.stdout === 'string') {
        error.stdout = error.stdout.replace(/\0/g, '');
      }
      if (typeof error?.stderr === 'string') {
        error.stderr = error.stderr.replace(/\0/g, '');
      }
      console.error(`Could not set up kubeconfig integration for ${ distro }:`, error);

      return `Error setting up integration`;
    }
    console.log(`kubeconfig integration for ${ distro } set to ${ state }`);
  }

  protected get nonBlacklistedDistros(): Promise<WSLDistro[]> {
    return (async() => {
      let wslOutput: string;

      try {
        wslOutput = await this.captureCommand({ encoding: 'utf16le' }, '--list', '--verbose');
      } catch (error: any) {
        console.error(`Error listing distros: ${ error }`);

        return Promise.resolve([]);
      }
      // As wsl.exe may be localized, don't check state here.
      const parser = /^[\s*]+(?<name>.*?)\s+\w+\s+(?<version>\d+)\s*$/;

      return wslOutput.trim()
        .split(/[\r\n]+/)
        .slice(1) // drop the title row
        .map(line => line.match(parser)?.groups)
        .filter(defined)
        .map(group => new WSLDistro(group.name, parseInt(group.version)))
        .filter((distro: WSLDistro) => !DISTRO_BLACKLIST.includes(distro.name));
    })();
  }

  /**
   * Returns a list of WSL distros that RD can integrate with.
   */
  protected get supportedDistros(): Promise<WSLDistro[]> {
    return (async() => {
      return (await this.nonBlacklistedDistros).filter(distro => distro.version === 2);
    })();
  }

  protected async markIntegration(distro: string, state: boolean): Promise<void> {
    try {
      const exe = await this.getLinuxToolPath(distro, executable('wsl-helper-linux'));
      const mode = state ? 'set' : 'delete';

      await this.execCommand({ distro, root: true }, exe, 'wsl', 'integration', 'state', `--mode=${ mode }`);
    } catch (ex) {
      console.error(`Failed to mark integration for ${ distro }:`, ex);
    }
  }

  async listIntegrations(): Promise<Record<string, boolean | string>> {
    // Get the results in parallel
    const distros = await this.nonBlacklistedDistros;
    const states = distros.map(d => (async() => [d.name, await this.getStateForIntegration(d)] as const)());

    return Object.fromEntries(await Promise.all(states));
  }

  /**
   * Tells the caller what the state of a distro is. For more information see
   * the comment on `IntegrationManager.listIntegrations`.
   */
  protected async getStateForIntegration(distro: WSLDistro): Promise<boolean|string> {
    if (distro.version !== 2) {
      console.log(`WSL distro "${ distro.name }": is version ${ distro.version }`);

      return `Rancher Desktop can only integrate with v2 WSL distributions (this is v${ distro.version }).`;
    }
    try {
      const exe = await this.getLinuxToolPath(distro.name, executable('wsl-helper-linux'));
      const stdout = await this.captureCommand(
        { distro: distro.name },
        exe, 'wsl', 'integration', 'state', '--mode=show');

      console.debug(`WSL distro "${ distro.name }": wsl-helper output: "${ stdout.trim() }"`);
      if (['true', 'false'].includes(stdout.trim())) {
        return stdout.trim() === 'true';
      } else {
        return `Error: ${ stdout.trim() }`;
      }
    } catch (error) {
      console.log(`WSL distro "${ distro.name }" ${ error }`);
      if ((typeof error === 'object' && error) || typeof error === 'string') {
        return `${ error }`;
      } else {
        return `Error: unexpected error getting state of distro`;
      }
    }
  }

  async removeSymlinksOnly(): Promise<void> {}
}
