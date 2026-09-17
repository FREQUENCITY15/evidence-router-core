import { reduce, idempotencyKey } from './.router/objectives/reducer.mjs';
const objectiveId = 'demo';
const events = [];
const add = (kind, extra = {}) => events.push({kind, seq: events.length + 1, objectiveId, atUtc: '2026-09-17T00:00:00Z', ...extra});
const show = label => {
  console.log('\n' + label);
  console.table(reduce(events).packets.map(({packetId,state,eligible,reason}) => ({packetId,state,eligible,reason})));
};
console.log('Synthetic event demonstration. No worker, model, network or file writes.');
add('objective_defined', {goal:'Demonstrate acceptance gating', nonGoals:['Run workers']});
for (const [packetId, dependsOn] of [['A', []], ['B', ['A']]]) {
  add('packet_defined', {packetId, planRevision:1, instructions:'Demo '+packetId, dependsOn, inputs:[], attemptAllowance:2, routePolicy:{defaultRoute:'demo'}, writeScope:{paths:[]}, outputContract:{artifacts:[{name:packetId+'.txt',required:true}]}});
}
add('plan_approved',{planRevision:1,authority:'operator'});
show('1. Plan approved: A eligible; B waiting');
add('dispatch_decided',{packetId:'A',planRevision:1,attempt:1,idempotencyKey:idempotencyKey({objectiveId,planRevision:1,packetId:'A',attempt:1})});
add('attempt_started',{packetId:'A',attempt:1,runId:'synthetic-A1'});
add('attempt_succeeded',{packetId:'A',attempt:1});
show('2. A succeeded: B still waiting');
add('assessment_recorded',{packetId:'A',attempt:1,authority:'controller',accepted:true,assessmentRef:'synthetic-assessment',assessmentSha256:'a'.repeat(64)});
show('3. A accepted: B eligible');
