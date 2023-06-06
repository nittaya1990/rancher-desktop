# shellcheck disable=SC2059
# https://www.shellcheck.net/wiki/SC2059 -- Don't use variables in the printf format string. Use printf '..%s..' "$foo".
# This file exists to print information about the configuration.

show_info() { # @test
    # In case the file is loaded as a test: bats tests/helpers/info.bash
    if [ -z "$RD_LOCATION" ]; then
        load load.bash
    fi

    if capturing_logs || taking_screenshots; then
        rm -rf "$PATH_BATS_LOGS"
    fi

    (
        local format="# %-25s %s\n"

        printf "$format" "Install location:" "$RD_LOCATION"
        printf "$format" "Resources path:" "$PATH_RESOURCES"
        echo "#"
        printf "$format" "Container engine:" "$RD_CONTAINER_ENGINE"
        printf "$format" "Using image allow list:" "$(bool using_image_allow_list)"
        if is_macos; then
            printf "$format" "Using VZ emulation:" "$(bool using_vz_emulation)"
        fi
        if is_windows; then
            printf "$format" "Using Windows executables:" "$(bool using_windows_exe)"
            printf "$format" "Using networking tunnel:" "$(bool using_networking_tunnel)"
        fi
        echo "#"
        printf "$format" "Capturing logs:" "$(bool capturing_logs)"
        printf "$format" "Taking screenshots:" "$(bool taking_screenshots)"
    ) >&3
}
