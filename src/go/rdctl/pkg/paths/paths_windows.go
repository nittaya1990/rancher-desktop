package paths

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

func GetPaths(getResourcesPathFuncs ...func() (string, error)) (Paths, error) {
	var getResourcesPathFunc func() (string, error)
	switch len(getResourcesPathFuncs) {
	case 0:
		getResourcesPathFunc = getResourcesPath
	case 1:
		getResourcesPathFunc = getResourcesPathFuncs[0]
	default:
		return Paths{}, errors.New("you can only pass one function in getResourcesPathFuncs arg")
	}

	homeDir, err := os.UserHomeDir()
	if err != nil {
		return Paths{}, fmt.Errorf("failed to get user home directory: %w", err)
	}
	localAppData := os.Getenv("LOCALAPPDATA")
	if localAppData == "" {
		localAppData = filepath.Join(homeDir, "AppData", "Local")
	}
	appHome := filepath.Join(localAppData, appName)
	paths := Paths{
		AppHome:       appHome,
		AltAppHome:    appHome,
		Config:        appHome,
		Cache:         filepath.Join(localAppData, appName, "cache"),
		WslDistro:     filepath.Join(localAppData, appName, "distro"),
		WslDistroData: filepath.Join(localAppData, appName, "distro-data"),
		ExtensionRoot: filepath.Join(localAppData, appName, "extensions"),
		Snapshots:     filepath.Join(localAppData, appName, "snapshots"),
	}
	paths.Logs = os.Getenv("RD_LOGS_DIR")
	if paths.Logs == "" {
		paths.Logs = filepath.Join(localAppData, appName, "logs")
	}
	paths.Resources, err = getResourcesPathFunc()
	if err != nil {
		return Paths{}, fmt.Errorf("failed to find resources directory: %w", err)
	}

	return paths, nil
}
