"""Minimal sanity checks for the kirk report parser."""

from ltpviewer.report import analyse_log, family_of, find_errno, parse_report


def _result(name, status, log, retval="0"):
    return {"test_fqn": name, "status": status,
            "test": {"command": name, "arguments": [], "log": log, "retval": [retval], "duration": 0.5,
                     "passed": 0, "failed": 0, "broken": 0, "skipped": 0, "warnings": 0, "result": status}}


def test_family():
    assert family_of("accept01") == "accept"
    assert family_of("fcntl17_64") == "fcntl"
    assert family_of("fchmodat2_01") == "fchmodat2"
    assert family_of("cve-2018-1000204") == "cve"
    assert family_of("netns_sysfs") == "netns_sysfs"


def test_errno_prefers_actual_error():
    assert find_errno("delete_module() failed unexpectedly; expected: ENOENT: EPERM (1)") == "EPERM"
    assert find_errno("Failed to create veth interfaces: EOPNOTSUPP") == "EOPNOTSUPP"
    assert find_errno("no errno here") is None


def test_reason_from_all_log_dialects():
    assert analyse_log("foo.c:12: TFAIL: boom: EPERM (1)\n", "fail")["reason"] == "boom: EPERM (1)"
    assert analyse_log("netns_sysfs 1 TBROK: no device\n", "brok")["reason"] == "no device"
    assert analyse_log("foo01    1  TCONF  :  foo.c:3: not here\n", "conf")["reason"] == "not here"


def test_hint_and_kconfig():
    log = ("x.c:1: TCONF: Hint: check something\nx.c:2: TCONF: real reason\n")
    assert analyse_log(log, "conf")["reason"] == "real reason"
    log = ("tst_kconfig.c:613: TINFO: Constraint 'CONFIG_FOO=y' not satisfied!\n"
           "tst_test.c:1475: TCONF: Aborting due to unsuitable kernel config, see above!\n")
    info = analyse_log(log, "conf")
    assert info["kconfig"] == ["CONFIG_FOO=y"]
    assert "CONFIG_FOO=y" in info["reason"]


def test_parse_report_duplicates_and_stable_id():
    data = {"results": [_result("a01", "pass", ""), _result("a01", "fail", "a.c:1: TFAIL: x\n", "1")]}
    rep = parse_report(data, name="demo")
    assert [t["key"] for t in rep.tests] == ["a01#0", "a01#1"]
    assert rep.id == parse_report(data, name="demo").id
    assert rep.summary()["counts"]["fail"] == 1
