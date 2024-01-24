/*
Copyright © 2022 SUSE LLC

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

		http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package factoryreset

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"

	dockerconfig "github.com/docker/docker/cli/config"
	"github.com/rancher-sandbox/rancher-desktop/src/go/rdctl/pkg/directories"
	p "github.com/rancher-sandbox/rancher-desktop/src/go/rdctl/pkg/paths"
	"github.com/sirupsen/logrus"
)

func addAppHomeWithoutSnapshots(appHome string) []string {
	haveSnapshots := false
	if snapshots, err := os.ReadDir(filepath.Join(appHome, "snapshots")); err == nil {
		haveSnapshots = len(snapshots) > 0
	}
	if !haveSnapshots {
		return []string{appHome}
	}
	appHomeMembers, err := os.ReadDir(appHome)
	if err != nil {
		logrus.Errorf("failed to read contents of dir %s: %s", appHome, err)
		return []string{appHome}
	}
	pathList := make([]string, 0, len(appHomeMembers))
	for _, entry := range appHomeMembers {
		if filepath.Base(entry.Name()) != "snapshots" {
			pathList = append(pathList, filepath.Join(appHome, entry.Name()))
		}
	}
	return pathList
}

// Most of the errors in this function are reported, but we continue to try to delete things,
// because there isn't really a dependency graph here.
// For example, if we can't delete the Lima VM, that doesn't mean we can't remove docker files
// or pull the path settings out of the shell profile files.
func deleteUnixLikeData(paths p.Paths, pathList []string) error {
	if err := deleteLimaVM(); err != nil {
		logrus.Errorf("Error trying to delete the Lima VM: %s\n", err)
	}
	for _, currentPath := range pathList {
		if err := os.RemoveAll(currentPath); err != nil {
			logrus.Errorf("Error trying to remove %s: %s", currentPath, err)
		}
	}
	if err := clearDockerContext(); err != nil {
		logrus.Errorf("Error trying to clear the docker context %s", err)
	}
	if err := removeDockerCliPlugins(paths.AltAppHome); err != nil {
		logrus.Errorf("Error trying to remove docker plugins %s", err)
	}

	homeDir, err := os.UserHomeDir()
	if err != nil {
		// If we can't get home directory, none of the below code is valid
		logrus.Errorf("Error trying to get home dir: %s", err)
		return nil
	}
	rawPaths := []string{
		".bashrc",
		".bash_profile",
		".bash_login",
		".profile",
		".zshrc",
		".cshrc",
		".tcshrc",
	}
	for i, s := range rawPaths {
		rawPaths[i] = path.Join(homeDir, s)
	}
	rawPaths = append(rawPaths, path.Join(homeDir, ".config", "fish", "config.fish"))

	return removePathManagement(rawPaths)
}

func deleteLimaVM() error {
	paths, err := p.GetPaths()
	if err != nil {
		return err
	}
	if err := directories.SetupLimaHome(paths.AppHome); err != nil {
		return err
	}
	execPath, err := os.Executable()
	if err != nil {
		return err
	}
	execPath, err = filepath.EvalSymlinks(execPath)
	if err != nil {
		return err
	}
	limactl := path.Join(path.Dir(path.Dir(execPath)), "lima", "bin", "limactl")
	return exec.Command(limactl, "delete", "-f", "0").Run()
}

func removeDockerCliPlugins(altAppHomePath string) error {
	cliPluginsDir := path.Join(dockerconfig.Dir(), "cli-plugins")
	entries, err := os.ReadDir(cliPluginsDir)
	if err != nil {
		if errors.Is(err, syscall.ENOENT) {
			// Nothing left to do here, since there is no cli-plugins dir
			return nil
		}
		return err
	}
	for _, entry := range entries {
		if entry.Type()&os.ModeSymlink != os.ModeSymlink {
			continue
		}
		fullPathName := path.Join(cliPluginsDir, entry.Name())
		target, err := os.Readlink(fullPathName)
		if err != nil {
			logrus.Errorf("Failed to follow the symbolic link for file %s: error: %s\n", fullPathName, err)
			continue
		}
		if strings.HasPrefix(target, path.Join(altAppHomePath, "bin")+"/") {
			os.Remove(fullPathName)
		}
	}
	return nil
}

func removePathManagement(dotFiles []string) error {
	const startTarget = `### MANAGED BY RANCHER DESKTOP START \(DO NOT EDIT\)`
	const endTarget = `### MANAGED BY RANCHER DESKTOP END \(DO NOT EDIT\)`

	// bash files etc. break if they contain \r's, so don't worry about them
	ptn := regexp.MustCompile(fmt.Sprintf(`(?ms)^(?P<preMarkerText>.*?)(?P<preMarkerNewlines>\n*)^%s.*?^%s\s*?$(?P<postMarkerNewlines>\n*)(?P<postMarkerText>.*)$`, startTarget, endTarget))

	for _, dotFile := range dotFiles {
		byteContents, err := os.ReadFile(dotFile)
		if err != nil {
			if !errors.Is(err, syscall.ENOENT) {
				logrus.Errorf("Error trying to read %s: %s\n", dotFile, err)
			}
			continue
		}
		contents := string(byteContents)
		parts := ptn.FindStringSubmatch(contents)
		if len(parts) == 0 {
			continue
		}

		preMarkerTextIndex := ptn.SubexpIndex("preMarkerText")
		preMarkerNewlineIndex := ptn.SubexpIndex("preMarkerNewlines")
		postMarkerNewlineIndex := ptn.SubexpIndex("postMarkerNewlines")
		postMarkerTextIndex := ptn.SubexpIndex("postMarkerText")
		if len(parts[preMarkerTextIndex]) == 0 && len(parts[postMarkerTextIndex]) == 0 {
			// Nothing of interest left in this file, so delete it
			err = os.RemoveAll(dotFile)
			if err != nil {
				// but continue processing the other files
				logrus.Errorf("Failed to delete file %s (error %s)\n", dotFile, err)
			}
			continue
		}

		newParts := []string{parts[preMarkerTextIndex]}

		preMarkerNewlines := parts[preMarkerNewlineIndex]
		postMarkerNewlines := parts[postMarkerNewlineIndex]
		if len(preMarkerNewlines) == 1 {
			newParts = append(newParts, preMarkerNewlines)
		} else if len(preMarkerNewlines) > 1 {
			// One of the newlines was inserted by the dotfile manager, but keep the others
			newParts = append(newParts, preMarkerNewlines[1:])
		}
		if len(parts[postMarkerTextIndex]) > 0 {
			if len(postMarkerNewlines) > 1 {
				// Either there was a newline before the marker block, and we have copied
				// it into the new file,
				// or the marker block was at the start of the file, in which case we can
				// drop one of the post-marker block newlines
				newParts = append(newParts, postMarkerNewlines[1:])
			}
			newParts = append(newParts, parts[postMarkerTextIndex])
		}
		newContents := strings.Join(newParts, "")
		filestat, err := os.Stat(dotFile)
		if err != nil {
			return fmt.Errorf("error trying to stat %q: %w", dotFile, err)
		}
		if err = os.WriteFile(dotFile, []byte(newContents), filestat.Mode()); err != nil {
			logrus.Errorf("error trying to update %s: %s\n", dotFile, err)
		}
	}
	return nil
}

type dockerConfigType map[string]interface{}

type PartialMeta struct {
	Metadata struct {
		Description string
	}
}

/**
 * cleanupDockerContextFiles - normally RD will remove any contexts from .docker/contexts/meta that it owns.
 * This function checks the dir for any contexts that were left behind, and deletes them.
 */
func cleanupDockerContextFiles() {
	os.RemoveAll(path.Join(dockerconfig.Dir(), "contexts", "meta", "b547d66a5de60e5f0843aba28283a8875c2ad72e99ba076060ef9ec7c09917c8"))
}

func clearDockerContext() error {
	// Ignore failure to delete this next file:
	os.Remove(path.Join(dockerconfig.Dir(), "plaintext-credentials.config.json"))

	cleanupDockerContextFiles()

	configFilePath := path.Join(dockerconfig.Dir(), "config.json")
	dockerConfigContents := make(dockerConfigType)
	contents, err := os.ReadFile(configFilePath)
	if err != nil {
		if errors.Is(err, syscall.ENOENT) {
			// Nothing left to do here, since the file doesn't exist
			return nil
		}
		return fmt.Errorf("factory-reset: error trying to read docker config.json: %w", err)
	}
	if err = json.Unmarshal(contents, &dockerConfigContents); err != nil {
		// If we can't json-unmarshal ~/.docker/config, nothing left to do
		return nil
	}
	currentContextName, ok := dockerConfigContents["currentContext"]
	if !ok {
		return nil
	}
	if currentContextName != "rancher-desktop" {
		return nil
	}
	delete(dockerConfigContents, "currentContext")
	contents, err = json.MarshalIndent(dockerConfigContents, "", "  ")
	if err != nil {
		return err
	}
	scratchFile, err := os.CreateTemp(dockerconfig.Dir(), "tmpconfig.json")
	if err != nil {
		return err
	}
	err = os.WriteFile(scratchFile.Name(), contents, 0600)
	scratchFile.Close()
	if err != nil {
		return err
	}
	return os.Rename(scratchFile.Name(), configFilePath)
}
