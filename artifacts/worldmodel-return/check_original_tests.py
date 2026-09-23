import json,os,sys
from pathlib import Path
source=Path(sys.argv[1]).resolve()
sys.path.insert(0,str(source))
import world_model,judge,pytest
assert Path(world_model.__file__).resolve().is_relative_to(source)
assert Path(judge.__file__).resolve().is_relative_to(source)
print("EXACT_IMPORT_BINDING="+json.dumps({"world_model":world_model.__file__,"judge":judge.__file__}),flush=True)
raise SystemExit(pytest.main([str(Path(__file__).resolve().parent / "baseline-tests"), "-q", "--import-mode=importlib", "-p", "no:cacheprovider"]))
