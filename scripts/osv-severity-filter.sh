#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# OSV-Scanner severity filter script
#
# Reads OSV-Scanner JSON output and exits with code 1 if any vulnerability
# has severity HIGH or CRITICAL; exits 0 otherwise.
#
# Usage: scripts/osv-severity-filter.sh <path-to-osv-output.json>
#
# Severity detection strategy (two-pass):
#
#   Primary:  database_specific.severity (GHSA-populated plain-English field,
#             e.g. "HIGH" or "CRITICAL"). Most reliable when present.
#
#   Fallback: CIA triad from CVSS v3 vector in severity[].score. Catches
#             advisories that omit the plain-English field. If any entry in
#             severity[] has type "CVSS_V3" and its score string contains one
#             of /C:H, /I:H, /A:H, the vuln is treated as HIGH/CRITICAL.
#
#   Limitation: CVSS 2.x vectors use different impact tokens (/C:C, /I:C,
#               /A:C). CVSS 2.x-only advisories log a warning but are NOT
#               blocked, to avoid false positives.
###############################################################################

die() {
    echo "ERROR: $*" >&2
    exit 1
}

usage() {
    cat >&2 <<EOF
Usage: $0 <path-to-osv-json>
       $0 --test

Reads OSV-Scanner JSON output and exits 1 if any vulnerability is HIGH or CRITICAL.

Arguments:
  <path-to-osv-json>  Path to OSV-Scanner output file (JSON format)
  --test              Run self-tests

Exit codes:
  0                   No HIGH/CRITICAL vulnerabilities found (or no vulns)
  1                   HIGH or CRITICAL vulnerabilities found
  2                   Usage/argument error
EOF
    exit 2
}

check_severity() {
    local json_file="$1"

    # Verify file exists
    if [[ ! -f "$json_file" ]]; then
        die "File not found: $json_file"
    fi

    # Validate JSON before any pipeline (Finding 3)
    if ! jq empty "$json_file" 2>/dev/null; then
        echo "ERROR: osv-severity-filter: cannot parse JSON file: $json_file" >&2
        exit 2
    fi

    local high_crit_vulns
    local total_vulns
    local output_details

    # Primary check: database_specific.severity field
    # Fallback check: any CVSS_V3 entry whose vector has /C:H, /I:H, or /A:H
    # (Finding 1)
    high_crit_vulns=$(jq -r '
        .results[]? |
        select(.packages[]? |
            select(.vulnerabilities[]? |
                (
                    (.database_specific.severity // "" | test("^(HIGH|CRITICAL)$"))
                    or
                    (.severity[]? | select(.type | test("CVSS_V3")) | .score | test("/C:H|/I:H|/A:H"))
                )
            )
        ) |
        .packages[]? |
        select(.vulnerabilities[]? |
            (
                (.database_specific.severity // "" | test("^(HIGH|CRITICAL)$"))
                or
                (.severity[]? | select(.type | test("CVSS_V3")) | .score | test("/C:H|/I:H|/A:H"))
            )
        ) |
        "\(.package.name)@\(.package.version)"
    ' "$json_file" | sort -u | grep -c . || true)

    # Warn about CVSS 2.x-only advisories (not blocked, see header note)
    local cvss2_only
    cvss2_only=$(jq -r '
        .results[]? | .packages[]? | .vulnerabilities[]? |
        select(
            (.database_specific.severity // "" | test("^(HIGH|CRITICAL)$") | not) and
            (.severity[]? | select(.type | test("CVSS_V3")) | .score | test("/C:H|/I:H|/A:H")) == null and
            (.severity[]? | select(.type == "CVSS_V2")) != null
        ) | .id
    ' "$json_file" 2>/dev/null | grep -c . || true)
    if [[ "$cvss2_only" -gt 0 ]]; then
        echo "WARNING: osv-severity-filter: $cvss2_only vuln(s) have CVSS 2.x vectors only — severity not assessed (CVSS 2.x tokens differ)" >&2
    fi

    # Get total vulnerability count for reference (Finding 4: use grep -c . instead of wc -l)
    total_vulns=$(jq -r '.results[]? | .packages[]? | .vulnerabilities[]? | .id' "$json_file" | grep -c . || true)

    if [[ "$high_crit_vulns" -gt 0 ]]; then
        # Print summary of HIGH/CRITICAL vulnerabilities
        output_details=$(jq -r '
            .results[] |
            select(.packages[]? |
                select(.vulnerabilities[]? |
                    (
                        (.database_specific.severity // "" | test("^(HIGH|CRITICAL)$"))
                        or
                        (.severity[]? | select(.type | test("CVSS_V3")) | .score | test("/C:H|/I:H|/A:H"))
                    )
                )
            ) |
            "Path: \(.source.path)\n" +
            (.packages[]? |
                select(.vulnerabilities[]? |
                    (
                        (.database_specific.severity // "" | test("^(HIGH|CRITICAL)$"))
                        or
                        (.severity[]? | select(.type | test("CVSS_V3")) | .score | test("/C:H|/I:H|/A:H"))
                    )
                ) |
                "  - \(.package.name)@\(.package.version): " +
                (.vulnerabilities[]? |
                    select(
                        (.database_specific.severity // "" | test("^(HIGH|CRITICAL)$"))
                        or
                        (.severity[]? | select(.type | test("CVSS_V3")) | .score | test("/C:H|/I:H|/A:H"))
                    ) |
                    "\(.id) [\(.database_specific.severity // "HIGH/CRITICAL via CVSS")]\n  "
                )
            )
        ' "$json_file")

        echo "Security gate FAILED: Found $high_crit_vulns package(s) with HIGH or CRITICAL vulnerabilities" >&2
        echo "" >&2
        echo "$output_details" >&2
        echo "" >&2
        echo "Scanned results: $total_vulns total vulnerabilities" >&2
        return 1
    else
        if [[ "$total_vulns" -eq 0 ]]; then
            echo "Security gate PASSED: No vulnerabilities found" >&2
        else
            echo "Security gate PASSED: Found $total_vulns vulnerabilities, none are HIGH or CRITICAL" >&2
        fi
        return 0
    fi
}

###############################################################################
# Self-test suite (runs if script is executed directly with --test)
###############################################################################

run_tests() {
    local test_count=0
    local pass_count=0

    echo "Running osv-severity-filter self-tests..."
    echo ""

    # Test 1: No vulnerabilities
    test_count=$(( test_count + 1 ))
    local test1_json=$(mktemp)
    cat > "$test1_json" <<'EOF'
{
  "results": []
}
EOF
    if check_severity "$test1_json" >/dev/null 2>&1; then
        echo "✓ Test 1 PASS: Empty results should exit 0"
        pass_count=$(( pass_count + 1 ))
    else
        echo "✗ Test 1 FAIL: Empty results should exit 0"
    fi
    rm -f "$test1_json"

    # Test 2: Low severity only
    test_count=$(( test_count + 1 ))
    local test2_json=$(mktemp)
    cat > "$test2_json" <<'EOF'
{
  "results": [
    {
      "source": { "path": "package.json" },
      "packages": [
        {
          "package": { "name": "lodash", "version": "4.17.20" },
          "vulnerabilities": [
            {
              "id": "GHSA-xxxx-xxxx-xxxx",
              "summary": "test",
              "severity": [
                { "type": "CVSS_V3", "score": "CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:N/A:N" }
              ],
              "database_specific": { "severity": "LOW" }
            }
          ]
        }
      ]
    }
  ]
}
EOF
    if check_severity "$test2_json" >/dev/null 2>&1; then
        echo "✓ Test 2 PASS: LOW severity should exit 0"
        pass_count=$(( pass_count + 1 ))
    else
        echo "✗ Test 2 FAIL: LOW severity should exit 0"
    fi
    rm -f "$test2_json"

    # Test 3: HIGH severity
    test_count=$(( test_count + 1 ))
    local test3_json=$(mktemp)
    cat > "$test3_json" <<'EOF'
{
  "results": [
    {
      "source": { "path": "requirements.txt" },
      "packages": [
        {
          "package": { "name": "requests", "version": "2.25.0" },
          "vulnerabilities": [
            {
              "id": "GHSA-yyyy-yyyy-yyyy",
              "summary": "test high",
              "severity": [
                { "type": "CVSS_V3", "score": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:L" }
              ],
              "database_specific": { "severity": "HIGH" }
            }
          ]
        }
      ]
    }
  ]
}
EOF
    if ! check_severity "$test3_json" >/dev/null 2>&1; then
        echo "✓ Test 3 PASS: HIGH severity should exit 1"
        pass_count=$(( pass_count + 1 ))
    else
        echo "✗ Test 3 FAIL: HIGH severity should exit 1"
    fi
    rm -f "$test3_json"

    # Test 4: CRITICAL severity
    test_count=$(( test_count + 1 ))
    local test4_json=$(mktemp)
    cat > "$test4_json" <<'EOF'
{
  "results": [
    {
      "source": { "path": "backend/uv.lock" },
      "packages": [
        {
          "package": { "name": "critical-pkg", "version": "1.0.0" },
          "vulnerabilities": [
            {
              "id": "GHSA-zzzz-zzzz-zzzz",
              "summary": "test critical",
              "severity": [
                { "type": "CVSS_V3", "score": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }
              ],
              "database_specific": { "severity": "CRITICAL" }
            }
          ]
        }
      ]
    }
  ]
}
EOF
    if ! check_severity "$test4_json" >/dev/null 2>&1; then
        echo "✓ Test 4 PASS: CRITICAL severity should exit 1"
        pass_count=$(( pass_count + 1 ))
    else
        echo "✗ Test 4 FAIL: CRITICAL severity should exit 1"
    fi
    rm -f "$test4_json"

    # Test 5: Mixed severities (HIGH and LOW)
    test_count=$(( test_count + 1 ))
    local test5_json=$(mktemp)
    cat > "$test5_json" <<'EOF'
{
  "results": [
    {
      "source": { "path": "app.json" },
      "packages": [
        {
          "package": { "name": "mixed-pkg", "version": "1.0.0" },
          "vulnerabilities": [
            {
              "id": "GHSA-aaaa-aaaa-aaaa",
              "summary": "low vuln",
              "database_specific": { "severity": "LOW" }
            },
            {
              "id": "GHSA-bbbb-bbbb-bbbb",
              "summary": "high vuln",
              "database_specific": { "severity": "HIGH" }
            }
          ]
        }
      ]
    }
  ]
}
EOF
    if ! check_severity "$test5_json" >/dev/null 2>&1; then
        echo "✓ Test 5 PASS: Mixed HIGH+LOW should exit 1"
        pass_count=$(( pass_count + 1 ))
    else
        echo "✗ Test 5 FAIL: Mixed HIGH+LOW should exit 1"
    fi
    rm -f "$test5_json"

    # Test 6: CVSS fallback — no database_specific.severity, but CVSS_V3 vector
    # with C:H/I:H/A:H — should be BLOCKED (exit 1)  (Finding 1)
    test_count=$(( test_count + 1 ))
    local test6_json=$(mktemp)
    cat > "$test6_json" <<'EOF'
{
  "results": [
    {
      "source": { "path": "go.sum" },
      "packages": [
        {
          "package": { "name": "cvss-fallback-pkg", "version": "2.0.0" },
          "vulnerabilities": [
            {
              "id": "GHSA-cvss-fallback-test",
              "summary": "no database_specific.severity but full CVSS CIA:H",
              "severity": [
                { "type": "CVSS_V3", "score": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }
              ]
            }
          ]
        }
      ]
    }
  ]
}
EOF
    if ! check_severity "$test6_json" >/dev/null 2>&1; then
        echo "✓ Test 6 PASS: CVSS fallback (no database_specific.severity, C:H/I:H/A:H vector) should exit 1"
        pass_count=$(( pass_count + 1 ))
    else
        echo "✗ Test 6 FAIL: CVSS fallback (no database_specific.severity, C:H/I:H/A:H vector) should exit 1"
    fi
    rm -f "$test6_json"

    echo ""
    echo "Test Results: $pass_count/$test_count tests passed"
    if [[ $pass_count -eq $test_count ]]; then
        echo "Status: PASS"
        return 0
    else
        echo "Status: FAIL"
        return 1
    fi
}

###############################################################################
# Main entry point
###############################################################################

# Finding 2: guard $1 safely with ${1:-} so set -u does not crash on zero args
if [[ "${BASH_SOURCE[0]}" == "${0}" ]] && [[ "${1:-}" == "--test" ]]; then
    run_tests
    exit $?
fi

# Normal operation: require exactly one argument
if [[ $# -ne 1 ]]; then
    usage
fi

check_severity "$1"
exit $?
