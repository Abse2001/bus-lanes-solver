/** Runs against the installed tarball, with no source-tree type dependencies. */
export const lengthTuningConsumerSource = String.raw`
import {
  BusLanesSolver, BusLanesPipelineSolver, SingleLayerConnectivitySolver,
  postProcessRoutedLengths, routedLengthMatchingProblem,
  type SimpleRouteJson, type Trace, type Wire,
  type PostRoutingLengthTuningOptions, type PostRoutingLengthTuningResult,
  type PostRoutingLengthProgress,
} from "@tscircuit/bus-lanes-solver"

function check(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label)
}
for (const exported of [BusLanesSolver, BusLanesPipelineSolver, SingleLayerConnectivitySolver,
  postProcessRoutedLengths, routedLengthMatchingProblem]) check(typeof exported === "function", "missing public export")

const wire = (x: number, y: number): Wire => ({route_type:"wire", x, y, layer:"top", width:0.1})
const traces: Trace[] = [
  {type:"pcb_trace",pcb_trace_id:"short",connection_name:"D0",route:[wire(0,0),wire(6,0)]},
  {type:"pcb_trace",pcb_trace_id:"long",connection_name:"D1",route:[wire(0,3),wire(8,3)]},
]
const input: SimpleRouteJson = {
  layerCount:4, allowedLayers:["top","bottom"], minTraceWidth:0.1,
  minTraceToPadEdgeClearance:0.1, bounds:{minX:-2,maxX:10,minY:-4,maxY:5},
  connections:traces.map(t=>({name:t.connection_name!,pointsToConnect:[t.route[0],t.route.at(-1)!] as Wire[]})),
  obstacles:[],traces:[], buses:[{busId:"DATA",connectionNames:["D0","D1"],maxLengthSkew:0.1}],
}
const output: SimpleRouteJson = {...structuredClone(input),traces:structuredClone(traces)}
const initialInput = JSON.stringify(input), initialOutput = JSON.stringify(output)
function extended(extra: number): Trace {
  const c=0.1, h=(extra+4*(2-Math.SQRT2)*c)/2
  return {...structuredClone(traces[0]),route:[traces[0].route[0],wire(1,0),wire(1+c,-c),
    wire(1+c,-h+c),wire(1+2*c,-h),wire(2-2*c,-h),wire(2-c,-h+c),
    wire(2-c,-c),wire(2,0),traces[0].route.at(-1)!]}
}
function finish(work: ReturnType<typeof postProcessRoutedLengths>): PostRoutingLengthTuningResult {
  let next=work.next(), steps=0
  while (!next.done && steps++<10000) {
    const progress: PostRoutingLengthProgress=next.value
    check(typeof progress.timingSolved==="boolean", "progress declaration/runtime mismatch")
    next=work.next()
  }
  check(next.done,"consumer fixture exceeded its bounded steps")
  const result: PostRoutingLengthTuningResult=next.value
  const score: readonly [number,number,number,number,number,number,number]=result.evaluation.score
  check(score.length===7,"public score tuple")
  return result
}
const solvedOptions: PostRoutingLengthTuningOptions = {
  maximumOperatorTimeMs:50,maximumPasses:1,maximumCandidatesPerOperator:2,
  proposalFactories:[function* (context) {
    const name: string=context.plan.id
    check(name.length>0 && context.deadlineMs>0,"context declaration/runtime mismatch")
    yield {replacements:[extended(2)],operator:"installed-consumer-match"}
  }],
}
const solved=finish(postProcessRoutedLengths(input,output,solvedOptions))
check(solved.physicalRoutingAccepted && solved.timingSolved,"public generator final matched output")
check(solved.output.traces?.length===2 && solved.evaluation.actualConstraintFailures===0,"complete matched output")
const partial=finish(postProcessRoutedLengths(input,output,{timeBudgetMs:0,maximumOperatorTimeMs:0}))
check(partial.physicalRoutingAccepted && !partial.timingSolved,"separate partial timing result")
check(partial.evaluation.actualConstraintFailures>0 && JSON.stringify(partial.output)===initialOutput,"budget fallback must retain physical baseline")
let invoked=false
const zero=finish(postProcessRoutedLengths(input,output,{maximumOperatorTimeMs:0,
  proposalFactories:[function*(){invoked=true;yield{replacements:[extended(2)]}}]}))
check(!invoked && !zero.timingSolved,"zero per-operator budget is public and enforced")
const cancelledWork=postProcessRoutedLengths(input,output,{proposalFactories:[function*(){
  yield {replacements:[extended(1)],operator:"partial-before-cancel"}
  while(true) yield undefined
}]})
const first=cancelledWork.next()
check(!first.done,"cancellation fixture must yield after a proposal")
// TypeScript's built-in Generator.return requires its return-value argument.
const cancelled=cancelledWork.return(undefined as never)
check(cancelled.done && cancelled.value.physicalRoutingAccepted && !cancelled.value.timingSolved,"cancellation returns complete best checkpoint")
check(cancelled.value.evaluation.sumBandErrorMm<partial.evaluation.sumBandErrorMm,"cancellation preserves the adopted partial improvement")
check(JSON.stringify(input)===initialInput && JSON.stringify(output)===initialOutput,"public API must not mutate caller inputs")
const problem=routedLengthMatchingProblem(input,traces)
check(problem.nets.length===2 && problem.nets.every(n=>n.lowerBoundMm<=n.currentLengthMm),"public scalar problem types/runtime")

const nativeConnections=Array.from({length:4},(_,i)=>({name:"Q"+i,pointsToConnect:[
  {x:i%2?-3:-4,y:i,layer:"top"},{x:i%2?3:4,y:i,layer:"top"},
]}))
const native: SimpleRouteJson={layerCount:4,allowedLayers:["top","bottom"],minTraceWidth:0.1,
  minTraceToPadEdgeClearance:0.05,minViaPadDiameter:0.3,minViaHoleDiameter:0.15,
  minViaHoleEdgeToViaHoleEdgeClearance:0.15,bounds:{minX:-8,maxX:8,minY:-2,maxY:6},
  connections:nativeConnections,obstacles:nativeConnections.flatMap(c=>c.pointsToConnect.map((p,e)=>({
    componentId:e?"receiver":"driver",shape:"circle" as const,center:{x:p.x,y:p.y},
    width:0.18,height:0.18,layers:["top"],connectedTo:[c.name],
  }))),traces:[],differentialPairs:[],buses:[0,1].map(i=>({busId:"B"+i,
    connectionNames:["Q"+(i*2),"Q"+(i*2+1)],maxLengthSkew:0.15,minLength:12,maxLength:3}))}
const pipeline=new BusLanesPipelineSolver(native,{goal:"physical",maxSearchIterations:10000,
  postRoutingLengthTuning:{maximumOperatorTimeMs:0,timeBudgetMs:0}})
check(pipeline.getLengthTuningReport()===null,"fresh pipeline report")
pipeline.solve()
check(pipeline.solved && !pipeline.failed,"installed fresh pipeline fixture")
const pipelineReport: PostRoutingLengthTuningResult|null=pipeline.getLengthTuningReport()
check(pipelineReport?.physicalRoutingAccepted && !pipelineReport.timingSolved,"public pipeline partial timing report")
check(pipelineReport.output.traces?.length===4,"pipeline retains all physical routes")
const safe=JSON.stringify(pipeline.getLengthTuningReport())
pipelineReport.output.traces![0].route[0].x+=100
check(JSON.stringify(pipeline.getLengthTuningReport())===safe,"pipeline report is an isolated clone")
`
