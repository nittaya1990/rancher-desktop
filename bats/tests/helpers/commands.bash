EXE=""
PLATFORM=$OS
if is_windows; then
    PLATFORM=linux
    if using_windows_exe; then
        EXE=".exe"
        PLATFORM=win32
    fi
fi

if using_containerd; then
    CONTAINER_ENGINE_SERVICE=containerd
else
    CONTAINER_ENGINE_SERVICE=docker
fi

if is_macos; then
    CRED_HELPER="$PATH_RESOURCES/$PLATFORM/bin/docker-credential-osxkeychain"
elif is_linux; then
    CRED_HELPER="$PATH_RESOURCES/$PLATFORM/bin/docker-credential-pass"
elif is_windows; then
    # Our docker-cli for WSL defaults to "wincred.exe" as well
    CRED_HELPER="$PATH_RESOURCES/win32/bin/docker-credential-wincred.exe"
fi

if is_windows; then
    RD_DOCKER_CONTEXT=default
else
    RD_DOCKER_CONTEXT=rancher-desktop
fi

CONTAINERD_NAMESPACE=default
WSL_DISTRO=rancher-desktop

no_cr() {
    tr -d '\r'
}
ctrctl() {
    if using_docker; then
        docker "$@"
    else
        nerdctl "$@"
    fi
}
curl() {
    command "curl$EXE" "$@"
}
docker() {
    docker_exe --context $RD_DOCKER_CONTEXT "$@"
}
docker_exe() {
    # Add path to bundled credential helpers to the front of the PATH
    PATH="$PATH_RESOURCES/$PLATFORM/bin:$PATH" "$PATH_RESOURCES/$PLATFORM/bin/docker$EXE" "$@" | no_cr
}
helm() {
    "$PATH_RESOURCES/$PLATFORM/bin/helm$EXE" "$@" | no_cr
}
kubectl() {
    kubectl_exe --context rancher-desktop "$@"
}
kubectl_exe() {
    "$PATH_RESOURCES/$PLATFORM/bin/kubectl$EXE" "$@" | no_cr
}
limactl() {
    # LIMA_HOME is set by paths.bash but not exported
    LIMA_HOME="$LIMA_HOME" "$PATH_RESOURCES/$PLATFORM/lima/bin/limactl" "$@"
}
nerdctl() {
    "$PATH_RESOURCES/$PLATFORM/bin/nerdctl$EXE" --namespace "$CONTAINERD_NAMESPACE" "$@" | no_cr
}
rdctl() {
    if is_windows; then
        "$PATH_RESOURCES/win32/bin/rdctl.exe" "$@" | no_cr
    else
        "$PATH_RESOURCES/$PLATFORM/bin/rdctl$EXE" "$@"
    fi
}
rdshell() {
    rdctl shell "$@"
}
rdsudo() {
    rdshell sudo "$@"
}
wsl() {
    wsl.exe -d "$WSL_DISTRO" "$@"
}
