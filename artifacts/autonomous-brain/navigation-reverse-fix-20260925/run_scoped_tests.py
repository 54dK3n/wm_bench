import importlib.util,sys
from pathlib import Path
import pytest
source=Path(sys.argv[1]);sys.path.insert(0,str(source.parent))
if source.name=="baseline_source":
 import autonomous_brain
 spec=importlib.util.spec_from_file_location("autonomous_brain.navigation",source/"navigation.py")
 module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 sys.modules["autonomous_brain.navigation"]=module
raise SystemExit(pytest.main(["-q","-p","no:cacheprovider",*sys.argv[2:]]))
