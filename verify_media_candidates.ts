import { Script } from "scripting"
import { MEDIA_CANDIDATE_LIMIT, MEDIA_CANDIDATE_TTL_MS, candidateDetailValue, clearMediaCandidates, filterMediaCandidates, listMediaCandidates, normalizeMediaCandidateURL, rememberMediaCandidate } from "./services/media-candidates"
const now=100000
clearMediaCandidates()
rememberMediaCandidate({source:"manual",url:"https://example.com/a?sig=1#x",title:"A",kind:"page"},now)
rememberMediaCandidate({source:"safari",url:"https://example.com/a?sig=1",pageURL:"https://example.com/watch",kind:"video"},now+1)
const deduplicated=listMediaCandidates(now+2)
for(let i=0;i<MEDIA_CANDIDATE_LIMIT+2;i++) rememberMediaCandidate({source:"manual",url:`https://example.com/${i}`},now+2+i)
const list=listMediaCandidates(now+3+MEDIA_CANDIDATE_LIMIT)
const checks:Array<[string,boolean]>=[
 ["keeps query and removes fragment",normalizeMediaCandidateURL("https://example.com/a?q=1#x")==="https://example.com/a?q=1"],
 ["rejects non-http",normalizeMediaCandidateURL("blob:https://example.com/x")===null],
 ["deduplicates candidate URL",deduplicated.filter(x=>x.url==="https://example.com/a?sig=1").length===1 && deduplicated[0]?.source==="safari"],
 ["caps records",list.length===MEDIA_CANDIDATE_LIMIT],
 ["keeps most recent first",list[0]?.url===`https://example.com/${MEDIA_CANDIDATE_LIMIT+1}`],
 ["expires candidates",listMediaCandidates(now+MEDIA_CANDIDATE_TTL_MS+MEDIA_CANDIDATE_LIMIT+10).length===0],
 ["filters recommended Safari records locally",filterMediaCandidates([{...list[0],source:"safari",kind:"hls",qualityHint:"推荐 · 自适应最高画质"}],"recommended").length===1],
 ["shows explicit unknown only for Safari details",candidateDetailValue(undefined,true)==="未知，导入并分析后可获取" && candidateDetailValue(undefined,false)==="不适用"],
]
const failed=checks.filter(([,ok])=>!ok).map(([n])=>n); if(failed.length) throw new Error(`Media candidate checks failed: ${failed.join(", ")}`); console.log(`Media candidate checks passed (${checks.length})`); Script.exit({passed:checks.length})
