"""Reproduce offline grasp geometry report; never invokes the simulator."""
import hashlib
import json
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0,str(ROOT))
from programs.opt2_grasp_fragment import opt2_grasp_scan_offsets
from programs.tests.test_opt2_grasp import Rig,module_for


def main():
    offsets=opt2_grasp_scan_offsets();half=math.radians(offsets[0]/2)
    report={'schema':'opt2-grasp-analytic-acceptance/v1','simulation_executed':False,
            'scope':'Ideal fixed-pose geometric guarantee and rounded old-geometry regression fixtures; not a replay of original controller or a live outcome guarantee.',
            'constants':{'min_forward_cm':4.75,'max_forward_cm':16.875,'max_side_cm':4.75,
                         'source':'competition-core.js normalize interaction defaults 0.38/1.35/0.38 world units; 8 units per metre',
                         'new_fitted_thresholds':False},
            'offsets_deg':offsets,
            'proof':{'max_covered_bearing_deg':math.degrees(math.acos(4.75/16.875)),
                     'grid_half_step_deg':offsets[0]/2,'grid_extent_with_half_step_deg':2.5*offsets[0],
                     'side_upper_cm':16.875*math.sin(half),
                     'forward_lower_after_original_side_failure_cm':math.sqrt(2)*4.75*math.cos(half)},
            'old_independent_geometry_regression':[],'source_sha256':{}}
    references=[('stage-1/round-2','map-01'),('stage-1/round-2','map-04'),
                ('stage-1/round-2','map-06'),('stage-1/round-3','map-09')]
    for directory,layout in references:
        p=ROOT/'artifacts/inloop'/directory/'batch_report.json'
        rows=json.loads(p.read_text());r=next(x for x in rows if x['map']==layout)
        attempts=r['grab_attempts'];a=attempts[0]
        rig=Rig(a['truth_forward_cm'],a['truth_right_cm']);ok=module_for(rig)._opt2_grab_loop()
        report['old_independent_geometry_regression'].append({
            'source':str(p.relative_to(ROOT)),'source_sha256':hashlib.sha256(p.read_bytes()).hexdigest(),
            'layout_report_only':layout,'true_ball_report_only':r['ball'],'target_position_report_only':r['ball_xz'],
            'original_attempts':attempts,'original_sequence_has_observed_side_failure':any(x['reason']=='side' for x in attempts),
            'fixture_uses_one_decimal_rounded_report_geometry':True,
            'offline_fixture_held':ok,'offline_fixture_forward_cm':sum(v[1] for v in rig.actions if v[0]=='forward'),
            'offline_fixture_actions':rig.actions,
            'independence_basis':'Distinct real target position and original local forward/lateral history; repeated B map03 omitted.'})
    for relative in ['programs/opt2_grasp_fragment.py','programs/tests/test_opt2_grasp.py']:
        report['source_sha256'][relative]=hashlib.sha256((ROOT/relative).read_bytes()).hexdigest()
    output=Path(__file__).with_name('geometry_acceptance.json')
    output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'report':str(output),'offsets_deg':offsets,'proof':report['proof'],
                      'old_geometries':len(references),'new_simulations':0},ensure_ascii=False))


if __name__=='__main__':main()
