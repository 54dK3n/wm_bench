try:
    _main_module = sys.modules.get("__main__")
    _student_source = getattr(_main_module, "__dict__", {}).get("student_source")
    if isinstance(_student_source, str):
        PROGRAM_SHA256 = hashlib.sha256(_student_source.encode("utf-8")).hexdigest()
    else:
        PROGRAM_SHA256 = "unavailable"
except Exception:
    PROGRAM_SHA256 = "unavailable"
