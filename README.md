# Rancher Desktop

Rancher Desktop is an open-source project to bring Kubernetes and container management to the desktop.
Windows and macOS versions of Rancher Desktop are available for download.

## Features

Rancher Desktop provides the following features in the form of a desktop application:

- The version of Kubernetes you choose
- Ability to test upgrading Kubernetes to a new version and see how your workloads respond
- Run containers, and build, push, and pull images (powered by [nerdctl])
- Expose an application in Kubernetes for local access

All of this is wrapped in an open-source application.

[nerdctl]: https://github.com/containerd/nerdctl

## Get The App

You can download the application for macOS and Windows on the [releases page].

[releases page]: https://github.com/rancher-sandbox/rancher-desktop/releases

Running on Windows requires [Windows Subsystem for Linux (WSL)].  This will be
installed automatically during Rancher Desktop installation.

[Windows Subsystem for Linux (WSL)]:
https://docs.microsoft.com/en-us/windows/wsl/install-win10

Note, [development builds] are available from the CI system. Development builds
are not signed.

[development builds]:
https://github.com/rancher-sandbox/rancher-desktop/actions/workflows/package.yaml?query=branch%3Amain

## Base Design Details

Rancher Desktop is an Electron application with the primary business logic
written in TypeScript and JavaScript.  It leverages several other pieces of
technology to provide the platform elements which include k3s, kubectl, nerdctl
WSL, qemu, and more. The application wraps numerous pieces of technology to
provide one cohesive application.

## Building The Source

Rancher can be built from source on macOS or Windows.  Cross-compilation is
currently not supported.  The following provides some detail on building.

### Prerequisites

Rancher Desktop is an [Electron] and [Node.js] application. Node.js v14 needs to
be installed to build the source.  On Windows, [Go] is also required.

[Electron]: https://www.electronjs.org/
[Node.js]: https://nodejs.org/
[Go]: https://golang.org/

#### Windows

There are two options for building from source on Windows: with a
[Development VM Setup](#development-vm-setup) or
[Manual Development Environment Setup](#manual-development-environment-setup)
with an existing Windows installation.
##### Development VM Setup

1. Download a Microsoft Windows 10 [development virtual machine].
2. Open a privileged PowerShell prompt (hit Windows Key + `X` and open
   `Windows PowerShell (Admin)`).
3. Run the [automated setup script]:
   ```powershell
   Set-ExecutionPolicy RemoteSigned -Scope CurrentUser

   iwr -useb 'https://github.com/rancher-sandbox/rancher-desktop/raw/main/scripts/windows-setup.ps1' | iex
   ```
4. Close the privileged PowerShell prompt.

You are now ready to clone the repository and run `npm install`.

[development virtual machine]: https://developer.microsoft.com/en-us/windows/downloads/virtual-machines/
[automated setup script]: ./scripts/windows-setup.ps1

##### Manual Development Environment Setup

1. Install [Windows Subsystem for Linux (WSL)] on your machine.
2. Install [Scoop] via `iwr -useb get.scoop.sh | iex`
3. Install git, go, nvm, and unzip via `scoop install git go nvm unzip`
4. Install NodeJS via `nvm install 14.17.0`
  * Remember to use it by running `nvm use 14.17.0`

[Scoop]: https://scoop.sh/

### How To Run

Use the following commands. The former is needed the first time or after an
update is pulled from upstream. The latter is needed for follow-up starts.

```
npm install
npm run dev
```

To build the distributable (application bundle on macOS, installer on Windows),
run `npm run build`.

### How To Test

Use the following commands to run unit tests and e2e tests.

```
npm test
npm run test:e2e
```
