"""Synthetic evidence-qualification tests; no simulation or scene records."""
import json
import unittest
from tools.p3_turn_calibration import public_inputs, extract, fit_all, residual_feasibility, repeats


def odo(index,tick,distance,heading):
    return {'input_index':index,'seq':index,'tick':tick,'type':'navigation_query','method':'odometry',
            'result':{'forwardCm':distance,'rightCm':0,'headingDeg':heading,'distanceCm':distance,'tick':tick}}


def sample_inputs(stop='max_distance',method='follow_road'):
    return [odo(0,0,0,0),
            {'input_index':1,'seq':1,'tick':0,'type':'navigation_query','method':'road_state',
             'result':{'tick':0,'exits':[{'roadId':'public-road','turnDeg':90}]}},
            {'input_index':2,'seq':2,'tick':0,'type':'navigation_control','method':method,
             'args':{'roadId':'public-road','maxCm':100,'speed':30,'obeySpeedLimit':True},
             'result':{'accepted':True,'stoppedBy':stop,'distanceCm':100,'elapsedTicks':500}},odo(3,500,100,0)]


class CalibrationTests(unittest.TestCase):
    def test_public_projection_cannot_access_truth(self):
        class Guard(dict):
            def get(self,key,default=None):
                if key in ('samples','startState','mission','renderTruth'):raise AssertionError(key)
                return super().get(key,default)
        record=Guard(inputs=[Guard(type='control',seq=1,tick=0,command={'kind':'turn_angle','angleDegrees':90,'durationTicks':30},startState={'forbidden_secret':1}),
                             Guard(type='navigation_query',method='mission',result={'objects':'forbidden_secret'})])
        result=public_inputs(record)
        self.assertNotIn('forbidden_secret',json.dumps(result))
        self.assertEqual(len(result),1)

    def test_only_complete_control_is_eligible(self):
        rows,excluded,_=extract(sample_inputs(),{'record_file':'synthetic'})
        self.assertEqual(len(rows),1);self.assertFalse(excluded)
        rows,excluded,_=extract(sample_inputs('junction'),{'record_file':'synthetic'})
        self.assertFalse(rows);self.assertIn('incomplete_control_stop_junction',excluded[0]['eligibility_reasons'])

    def test_missing_exact_end_cannot_use_nearby_odometry(self):
        items=sample_inputs();items[-1]['tick']=501;items[-1]['result']['tick']=501
        rows,excluded,_=extract(items,{})
        self.assertFalse(rows);self.assertIn('missing_exact_end_public_odometry',excluded[0]['eligibility_reasons'])

    def test_intervening_motion_invalidates_boundary(self):
        items=sample_inputs();items.insert(3,{'input_index':10,'type':'control','command':{'kind':'drive'},'tick':500})
        rows,excluded,_=extract(items,{})
        self.assertFalse(rows);self.assertIn('missing_exact_end_public_odometry',excluded[0]['eligibility_reasons'])

    def test_pure_turn_is_auxiliary_not_road_group(self):
        items=[odo(0,0,0,0),{'input_index':1,'seq':1,'tick':0,'type':'control',
                'command':{'kind':'turn_angle','angleDegrees':90,'durationTicks':30}},odo(2,30,0,90)]
        rows,excluded,aux=extract(items,{})
        self.assertFalse(rows);self.assertFalse(excluded);self.assertEqual(len(aux),1)
        self.assertEqual(repeats(rows)['exit_90_count'],0)

    def test_three_short_steps_do_not_form_100cm(self):
        rows,_,_=extract(sample_inputs(),{})
        row=rows[0];row['args']['maxCm']=10;row['distance_cm']=10
        self.assertEqual(repeats([row]*10)['single_100cm_straight_count'],0)

    def test_fit_uses_all_rows_and_reports_bad_residual(self):
        rows=[{'distance_cm':d,'turn_deg':a,'elapsed_ticks':t,'source':{},'input_index':i,'input_seq':i}
              for i,(d,a,t) in enumerate([(10,0,50),(0,90,90),(100,180,680)])]
        fit=fit_all(rows)
        self.assertAlmostEqual(fit['a_ticks_per_cm'],5);self.assertAlmostEqual(fit['b_ticks_per_deg'],1)
        self.assertAlmostEqual(fit['k'],.2);self.assertTrue(fit['residuals_at_most_10pct'])
        rows.append({'distance_cm':10,'turn_deg':0,'elapsed_ticks':1000,'source':{},'input_index':3,'input_seq':3})
        fit=fit_all(rows);self.assertEqual(fit['samples'],4);self.assertFalse(fit['residuals_at_most_10pct'])

    def test_identical_public_features_prove_scalar_model_impossible(self):
        rows=[{'distance_cm':10,'turn_deg':1.4,'elapsed_ticks':t} for t in (55,112)]
        result=residual_feasibility(rows)
        self.assertFalse(result['any_nonnegative_k_can_satisfy_10pct'])
        self.assertAlmostEqual(result['identical_feature_contradictions'][0]['minimum_possible_max_relative_residual'],57/167)


if __name__=='__main__':unittest.main()
