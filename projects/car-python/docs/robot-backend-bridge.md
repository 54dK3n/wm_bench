# Local robot backend bridge v1

This is a transport and sensor boundary, not a planner. It does not start a
simulation, choose a layout, grant record access, or change the native scoring
contract. It is disabled unless `CHENLONG_ROBOT_BRIDGE=1` or
`createServer({robotBridgeEnabled: true})` is used. An explicit `false` overrides
the environment. Optional broker settings are supplied as `robotBridge: {...}`:
`pollTimeoutMs` defaults to 25000, `maxSessions` to 128 and `maxCommands` to 10000.
The latter limits are transport capacity limits, not task evaluation thresholds.

All routes below are under `/api/v1/robot-bridge`, accept only loopback clients,
and retain the server's existing same-origin policy. CORS and CSP are unchanged.
Query strings are rejected. POST bodies are JSON, at most 64 KiB.

## Controller and client routes

| Method and suffix | Authentication | Body / response |
| --- | --- | --- |
| POST `/controllers` | Existing browser login cookie | `{}` → `{protocolVersion,bridgeId,controllerToken,clientToken}` |
| GET `/controllers/:bridgeId/next` | Same logged-in owner + `X-Robot-Bridge-Controller` | Long-polls → `{command:{requestId,method,params}}` or `{command:null}` |
| POST `/controllers/:bridgeId/results` | Same owner + controller token | `{requestId,tick,result}` or `{requestId,tick,error:{code}}` → command status |
| POST `/controllers/:bridgeId/close` | Same owner + controller token | `{}` → `{closed:true}` |
| GET `/controllers/:bridgeId/trace` | Same owner + controller token | Deterministic public bridge trace |
| POST `/:bridgeId/commands` | `X-Robot-Bridge-Client` | `{requestId,method,params}` → 202 queued/dispatched, or 200 existing terminal result |
| GET `/:bridgeId/commands/:requestId` | Client token | `{requestId,status,result? ,error?:{code}}` |
| GET `/:bridgeId/trace` | Client token | Deterministic public bridge trace |

The registration response is control-plane data and must not be copied into a
robot record. The external planner receives only `bridgeId` and `clientToken`.
It receives neither login cookies nor the controller token. Controller and client
tokens are distinct, independently generated, and held hashed by the broker.
The client header is explicitly rejected on non-bridge routes and on controller
routes, even if another credential is also presented. It is not an alternative
admin, record, scene, or login credential. A bridge capability does not sandbox an
otherwise unrestricted process or revoke unrelated credentials it already has.

## Command contract

`robot-bridge-contract.js` is shared by Node and browser as
`RobotBridgeContract`. It exposes `normalizeCommand`, `sanitizeResponse`,
`METHODS`, `ERROR_CODES`, and fixed `CAMERA_PARAMETERS` intrinsics.

| Method | Params | Public result |
| --- | --- | --- |
| observe | `{category?,confidence?}` | `{frameId,tick,width:640,height:480,detections:[{category,confidence,bbox:{x,y,w,h},source}]}` |
| camera_parameters | `{}` | `{width,height,fx,fy,cx,cy,verticalFovDeg,mount:{forwardCm,rightCm,upCm,pitchDeg}}` |
| odometry | `{}` | `{forwardCm,rightCm,headingDeg,distanceCm,tick}` relative to run origin |
| local_road | `{}` | `{onRoad,lateralOffsetCm,headingErrorDeg,leftClearanceCm,rightClearanceCm,frontClearanceCm,atJunction,atNode,exits:[{angleDeg}],tick}` |
| holding | `{}` | `{holding}` boolean; the gripper does not identify the object |
| grab / release | `{}` | `{completed:true}`; use holding to assess possession |
| forward / backward | `{distanceCm,speed?}` | `{completed:true}` |
| turn | `{angleDeg,speed?}` | `{completed:true}`; positive left, negative right |
| follow_road | `{distanceCm,speed?}` | `{accepted,stoppedBy,distanceCm,elapsedTicks}` |
| take_exit | `{angleDeg,speed?}` | Same as follow_road |

Categories are appearance classes: red-ball, blue-ball, obstacle and
storage-zone; observe category may also be null. Task roles (target,
distractor) are never a sensor output. The simulator uses `virtual-cv`:
its red/blue pixel classifiers have legacy names `target`/`distractor`, which
the adapter translates to `red-ball`/`blue-ball`; no scene-object role is read.
On physical-camera YOLO output, ball colour comes from the sports-ball class
plus a chroma ratio on its box. `source` is preserved as `virtual-cv` or `yolo`,
never relabelled. The independent `storage-ground-pixels` detector reports the
visible #00ff00 ground region and supplies that exact source value. Legacy
upright storage and cleanup signs are excluded because they are not a ground
storage region. Taught templates are not bridge detections. Confidence is 0–1. Basic travel is 0.1–500cm,
road following 10–500cm, speed 10–100%, turn magnitude 1–360°, and exit relative
angle −180–180°. These reuse existing platform argument bounds. Unknown methods,
extra parameters and nonnumeric/nonfinite values are rejected. There is no
mission, map graph, task state, release preview, automatic approach, arbitrary
JavaScript, arbitrary sensor name or raw road-ID method.

Boxes are in the original 640×480 camera image, not the detector's padded
640×640 image. The browser adapter must remove the 80px vertical letterbox offset
and clip to the source image. Frame identity, pixels and detections must come
from the same capture. No range, bearing, object identity or world projection is
returned. Camera intrinsics are fixed; mount values are measured from the actual
rig and converted to cm. `upCm` is ground-referenced; no global transform is
permitted. In Guangyang's 8 world-units/meter scene the current rig gives forward
5.375cm and ground-relative height 8.0625cm (not 43cm/54cm).

The controller resolves `take_exit.angleDeg` against its fresh local exits
internally. Global road/node IDs remain inside the controller. Ambiguous or
stale choices fail; matching must not silently substitute an arbitrary global
road. Movement invalidates the previous local-exit snapshot.

## Ordering, uncertainty and records

Only one command may be dispatched at a time. While it is active, `next` returns
null and never redelivers it. An identical request ID plus normalized command
returns existing status. Reusing the ID with different content returns 409.
Clients should use deterministic request IDs such as `command_0001` so they can
compare records without normalizing random IDs.

An HTTP polling timeout does not cancel or retry an action. A lost response must
be resolved by querying status. On controller close, the dispatched command is
`unknown`, queued commands are `cancelled`, and the session cannot be reused.
There is no automatic command timeout or replay. If a controller disappears
without closing, a dispatched command remains unresolved; a caller must not
assume it was unexecuted. Invalid controller output closes the bridge and marks
the physical outcome unknown.

Controller results must include a nonnegative, monotonic simulation `tick`;
sensor result ticks must agree. The trace records request, dispatch, terminal
result and rejected method/parameter attempts. Request and rejection entries use
the latest completed tick, initially zero. It has sequence numbers and the
caller-supplied request IDs, but no wall-clock timestamps, owner IDs, random
bridge ID, credentials, source geometry or native truth. Unknown rejected
parameter values are intentionally not copied. Full sensor responses are
projected field by field, including nested objects; future fields are not
implicitly exposed.

The browser adapter must keep its native input/frame recording intact and bind
the separate bridge trace to that execution on the trusted evaluation side.
Do not substitute bbox responses for the legacy native observe result, append
unrecognized native input types, or represent denied queries as manual controls.
Native records, app logs (which can contain true grab geometry), global map
metadata and top-down screenshots are not planner responses.

From `robot-backend-v4-stage1-r2`, the page-controller-only evaluation export
also contains `sensorAudit`. Each observe entry has
`{requestId,frameId,tick,params,visionDetections,storageDetections,robotDetections}`.
`visionDetections` preserves the complete unfiltered native camera detector
output; `storageDetections` preserves the independent ground detector output;
`robotDetections` is the four-class, 640×480 source-image projection before
requested category/confidence filtering. These arrays retain raw confidence
precision and detector order. Evaluation must independently map and project
the raw arrays, explicitly report excluded legacy classes, and compare every
entry to the bridge response. It must not use the adapter's own projection as
the only oracle. `sensorAudit` is never returned by a bridge method.

The earlier r1 empty-detection record equality and bridge-observe acceptance
are invalidated. Only the new nonempty per-class, raw-content, expected-visible,
pixel-hash and rejection checks can re-establish stage 1 acceptance.

## Offline checks

Run `node --test tests/robot-bridge.test.js tests/robot-camera-detector.test.js tests/storage-region-pixels.test.js`. HTTP tests start only ephemeral
loopback servers with temporary data directories; they do not load a browser or
run a simulator. Tests cover authentication/capability separation, unchanged
cross-origin rejection, exact allowed parameter sets, hidden-field getters,
source-image boxes, single dispatch, duplicate IDs, long-poll expiry, unresolved
outcomes, response sanitization and deterministic rejection traces.
