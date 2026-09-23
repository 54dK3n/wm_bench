"""Synthetic file-contract failures; no simulator or native controller executed."""
import base64
import copy
import hashlib
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from opt2_evidence_audit import audit_native_evidence

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==')


def sha(data):return hashlib.sha256(data).hexdigest()
def save(path, value):path.write_text(json.dumps(value)+'\n')


def fixture(folder):
    source='PROGRAM_VERSION="synthetic"\n';(folder/'program.py').write_text(source)
    (folder/'frame.png').write_bytes(PNG)
    detector={'category':'target','distanceCm':60,'bearingDeg':1,'confidence':.9}
    native={'frameId':7,'evidenceId':'v1','tick':10,'stateRevision':2,'seq':5,'t':200,
            'mimeType':'image/png','width':1,'height':1,'sha256':sha(PNG),'byteLength':len(PNG),
            'pngBase64':base64.b64encode(PNG).decode()}
    frame={k:v for k,v in native.items() if k!='pngBase64'}
    frame.update(image='frame.png',exportedSha256=sha(PNG))
    query={'seq':6,'t':200,'tick':10,'type':'vision_query','method':'observe','frameId':7,
           'evidenceId':'v1','result':[detector]}
    truth={'runId':'run','exactRenderState':True,'sameTickAndRevision':True,'frameId':7,'evidenceId':'v1',
           'captureTick':10,'evidenceTick':10,'captureStateRevision':2,'evidenceStateRevision':2,
           'evidenceSeq':5,'imageSha256':sha(PNG),'nativeByteLength':len(PNG)}
    vision={'taskId':'R2-GYI-MVP-02','runId':'run','frames':[frame],'queries':[query],
            'renderTruth':{'frames':[truth],'errors':[]},'exportErrors':[],
            'nativeFrameCount':1,'nativeFrameBytes':len(PNG),'nativeQueryCount':1}
    record={'runId':'run','taskId':'R2-GYI-MVP-02','sourceCode':source.strip(),
            'events':[{'type':'run_started'}],'inputs':[query],'samples':[{'tick':10,'x':0}],
            'visionFrames':[native]}
    raw={'taskId':'R2-GYI-MVP-02','fullRecordFile':'record.json','visionEvidenceFile':'vision.json',
         'samplesFile':'samples.json','program':'program.py',
         'record':{'top':{'runId':'run','taskId':'R2-GYI-MVP-02'},'events':record['events'],
                   'sampleCount':1,'vision':{'frameCount':1,'frameBytes':len(PNG),'queryCount':1}},
         'lines':[{'event':'program_version','file_sha256':sha(source.strip().encode())},
                  {'event':'observe','tick':10,'raw':[detector]}]}
    return raw,record,vision


def archive(folder, raw, record, vision, samples=None):
    save(folder/'record.json',record);save(folder/'vision.json',vision)
    save(folder/'samples.json',record['samples'] if samples is None else samples)
    b=(folder/'record.json').read_bytes()
    raw['fullRecordExport']={'runId':'run','taskId':'R2-GYI-MVP-02','sha256':sha(b),'bytes':len(b),
                            **{k:len(record[k]) for k in ('events','inputs','samples','visionFrames')}}
    save(folder/'raw.json',raw)
    return audit_native_evidence(raw,record,folder/'raw.json')


def test_complete_independent_native_binding(tmp_path):
    raw,record,vision=fixture(tmp_path);result=archive(tmp_path,raw,record,vision)
    assert result['all_pass'],result['mismatches']
    assert result['native_bytes']==len(PNG)


@pytest.mark.parametrize('kind', ['run','task','frame_metadata','native_png','export_png','query_result',
                                  'query_frame','duplicate_frame','missing_truth','wrong_revision',
                                  'wrong_tick','truth_not_exact','source','observe_raw','sample_copy'])
def test_each_binding_is_recomputed_not_export_flag(tmp_path,kind):
    raw,record,vision=fixture(tmp_path);samples=None
    if kind=='run':vision['runId']='other'
    if kind=='task':vision['taskId']='other'
    if kind=='frame_metadata':vision['frames'][0]['width']=2
    if kind=='native_png':record['visionFrames'][0]['pngBase64']=base64.b64encode(PNG+b'x').decode()
    if kind=='export_png':(tmp_path/'frame.png').write_bytes(PNG+b'x')
    if kind=='query_result':vision['queries']=copy.deepcopy(vision['queries']);vision['queries'][0]['result']=[]
    if kind=='query_frame':record['inputs'][0]['frameId']=99  # Query alias changes both, so independent frame binding must catch it.
    if kind=='duplicate_frame':vision['frames'].append(copy.deepcopy(vision['frames'][0]))
    if kind=='missing_truth':vision['renderTruth']['frames']=[]
    if kind=='wrong_revision':vision['renderTruth']['frames'][0]['captureStateRevision']=3
    if kind=='wrong_tick':vision['renderTruth']['frames'][0]['captureTick']=9
    if kind=='truth_not_exact':vision['renderTruth']['frames'][0]['sameTickAndRevision']=False
    if kind=='source':record['sourceCode']='different executed source'
    if kind=='observe_raw':raw['lines'][1]['raw']=[]
    if kind=='sample_copy':samples=[{'tick':10,'x':1}]
    result=archive(tmp_path,raw,record,vision,samples)
    assert not result['all_pass'] and result['mismatches'],kind


def test_passed_record_argument_must_be_the_loaded_archive(tmp_path):
    raw,record,vision=fixture(tmp_path);archive(tmp_path,raw,record,vision)
    changed=copy.deepcopy(record);changed['events'].append({'type':'program_error'})
    result=audit_native_evidence(raw,changed,tmp_path/'raw.json')
    assert not result['all_pass'] and not result['checks']['record_argument_matches_preserved_file']


def test_loaded_archive_hash_cannot_be_replaced_by_manifest_flags(tmp_path):
    raw,record,vision=fixture(tmp_path);archive(tmp_path,raw,record,vision)
    raw['fullRecordExport']['sha256']='0'*64;save(tmp_path/'raw.json',raw)
    result=audit_native_evidence(raw,record,tmp_path/'raw.json')
    assert not result['all_pass'] and not result['checks']['complete_archive_hash_and_bytes']


def test_missing_png_is_explicit_failure_not_exception(tmp_path):
    raw,record,vision=fixture(tmp_path);archive(tmp_path,raw,record,vision)
    (tmp_path/'frame.png').unlink()
    result=audit_native_evidence(raw,record,tmp_path/'raw.json')
    assert not result['all_pass'] and result['mismatches']


def test_nonball_detections_retained_in_native_query_but_not_required_in_redblue_log(tmp_path):
    raw,record,vision=fixture(tmp_path)
    record['inputs'][0]['result'].append({'category':'obstacle','distanceCm':40,'bearingDeg':0,'confidence':.8})
    result=archive(tmp_path,raw,record,vision)
    assert result['all_pass'],result['mismatches']
