load '../helpers/load'

########################################################################

local_setup() {
    COUNTER="${BATS_FILE_TMPDIR}/counter"
    reset_counter
}

reset_counter() {
    echo 0 >"$COUNTER"
    SECONDS=0
}

# Increment counter file. Return success when counter >= max.
inc_counter() {
    local max=${1-9999}
    local counter=$(($(cat "$COUNTER") + 1))
    echo $counter >"$COUNTER"
    ((counter >= max))
}

assert_counter_is() {
    run cat "${COUNTER}"
    assert_output "$1"
}

is() {
    local expect=$1
    # shellcheck disable=SC2086 # we want to split on whitespace
    run ${BATS_TEST_DESCRIPTION}
    assert_success
    assert_output "$expect"
}

is_quoted() {
    is "\"$1\""
}

########################################################################

@test 'to_lower Upper and Lower' {
    is "upper and lower"
}

@test 'to_lower' {
    is ""
}

@test 'to_upper 123+abc' {
    is "123+ABC"
}

@test 'to_upper' {
    is ""
}

########################################################################

check_truthiness() {
    local predicate=$1
    local value

    # test true values
    for value in 1 true True TRUE yes Yes YES any; do
        run "$predicate" "$value"
        "${assert}_success"
    done

    # test false values
    for value in 0 false False FALSE no No NO ''; do
        run "$predicate" "$value"
        "${assert}_failure"
    done
}

@test 'is_true' {
    check_truthiness is_true
}

@test 'is_false' {
    assert=refute
    check_truthiness is_false
}

@test 'bool [ 0 -eq 0 ]' {
    is true
}

@test 'bool [ 0 -eq 1 ]' {
    is false
}

########################################################################

@test 'validate_enum OS should pass' {
    run validate_enum OS darwin linux windows
    assert_success
}

@test 'validate_enum FRUIT should fail' {
    FRUIT=apple
    run validate_enum FRUIT banana cherry pear
    assert_failure
    # Can't check output; it is written using "fatal":
    # FRUIT=apple is not a valid setting; select from [banana cherry pear]
}

########################################################################

@test 'is_xxx' {
    # Exactly one of the is_xxx functions should return true
    count=0
    for os in linux macos windows; do
        if "is_$os"; then
            ((++count))
        fi
    done
    ((count == 1))
}

########################################################################

get_json_test_data() {
    # The run/assert silliness is because shellcheck gets confused by direct assignment to $output
    run echo '{"String":"string", "False":false, "Null":null}'
    assert_success
}

@test 'jq_output extracts string value' {
    get_json_test_data
    run jq_output .String
    assert_success
    assert_output string
}

@test 'jq_output extracts "false" value' {
    get_json_test_data
    run jq_output .False
    assert_success
    assert_output false
}

@test 'jq_output cannot extract "null" value' {
    get_json_test_data
    run jq_output .Null
    assert_failure
    assert_output null
}

@test 'jq_output fails when key is not found' {
    get_json_test_data
    run jq_output .DoesNotExist
    assert_failure
    assert_output null
}

@test 'jq_output fails on null' {
    output=null
    run jq_output .Anything
    assert_failure
    assert_output null
}

@test 'jq_output fails on undefined' {
    output=undefined
    run jq_output .Anything
    assert_failure
    assert_output --partial "parse error"
}

@test 'jq_output fails on non-JSON data' {
    output="This is not JSON"
    run jq_output .Anything
    assert_failure
    assert_output --partial "parse error"
}

@test 'jq_output does not return a newline when the output is "nothing"' {
    output=""
    output=$(
        jq_output .Anything
        echo "."
    )
    assert_output "."
}

@test 'jq_output does return a newline when the output is the empty string' {
    output='{"Empty": ""}'
    output=$(
        jq_output .Empty
        echo "."
    )
    assert_output $'\n.'
}

########################################################################

@test 'this_function' {
    foo() {
        this_function
    }
    run foo
    assert_success
    assert_output foo
}

@test 'calling_function' {
    bar() {
        baz
    }
    baz() {
        calling_function
    }
    run bar
    assert_success
    assert_output bar
}

########################################################################

@test 'call_local_function' {
    local_func() {
        echo local_func
    }
    func() {
        call_local_function
    }
    run func
    assert_success
    assert_output local_func
}

########################################################################

@test 'try will run command at least once' {
    run try --max 0 --delay 15 inc_counter
    assert_failure
    assert_counter_is 1
    # "try" should not have called "sleep 15" at all
    ((SECONDS < 15))
}

@test 'try will stop as soon as the command succeeds' {
    run try --max 3 --delay 3 inc_counter 2
    assert_success
    assert_counter_is 2
    # "try" should have called "sleep 3" exactly once
    ((SECONDS >= 3))
    if ((SECONDS >= 6)); then
        # maybe slow machine; try again with longer sleep
        reset_counter
        run try --max 3 --delay 15 inc_counter 2
        assert_success
        assert_counter_is 2
        # "try" should have called "sleep 15" exactly once
        ((SECONDS >= 15))
        ((SECONDS < 30))
    fi
}

@test 'try will return after max retries' {
    run try --max 3 --delay 3 inc_counter
    assert_failure
    assert_counter_is 3
    # "try" should have called "sleep 3" exactly twice
    ((SECONDS >= 6))
    if ((SECONDS >= 9)); then
        # maybe slow machine; try again with longer sleep
        reset_counter
        run try --max 3 --delay 15 inc_counter
        assert_failure
        assert_counter_is 3
        # "try" should have called "sleep 15" exactly twice
        ((SECONDS >= 30))
        ((SECONDS < 45))
    fi
}

########################################################################

@test 'json_string' {
    run json_string foo\ bar\"baz\'
    assert_success
    assert_output "\"foo bar\\\"baz'\""
}

########################################################################

@test 'join_map echo' {
    run join_map / echo usr local bin
    assert_success
    assert_output usr/local/bin
}

@test 'join_map false' {
    run join_map / false usr local bin
    assert_failure
}

@test 'join_map json_string' {
    run join_map ", " json_string true "foo bar" baz:80
    assert_success
    assert_output '"true", "foo bar", "baz:80"'
}

@test 'join_map empty list' {
    run join_map / echo
    assert_success
    assert_output ''
}

########################################################################

@test 'image_without_tag_as_json_string busybox' {
    is_quoted busybox
}

@test 'image_without_tag_as_json_string busybox:latest' {
    is_quoted busybox
}

@test 'image_without_tag_as_json_string busybox:5000' {
    is_quoted busybox
}

@test 'image_without_tag_as_json_string registry.io:5000' {
    is_quoted registry.io:5000
}

@test 'image_without_tag_as_json_string registry.io:5000/busybox' {
    is_quoted registry.io:5000/busybox
}

@test 'image_without_tag_as_json_string registry.io:5000/busybox:8080' {
    is_quoted registry.io:5000/busybox
}

########################################################################

@test 'unique_filename without extension' {
    run unique_filename "$COUNTER"
    assert_success
    assert_output "${COUNTER}_2"
    touch "$output"

    run unique_filename "$COUNTER"
    assert_success
    assert_output "${COUNTER}_3"
}

@test 'unique_filename with extension' {
    run unique_filename "$COUNTER" .png
    assert_success
    assert_output "${COUNTER}.png"
    touch "$output"

    run unique_filename "$COUNTER" .png
    assert_success
    assert_output "${COUNTER}_2.png"
    touch "$output"

    run unique_filename "$COUNTER" .png
    assert_success
    assert_output "${COUNTER}_3.png"
}
