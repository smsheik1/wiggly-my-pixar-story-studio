// LangGraph Studio entry point (see langgraph.json). Exports the same workflow
// graph the runner uses, compiled without a checkpointer: the Agent Server
// supplies its own. Read-only view for Studio; real runs still go through
// runner.mjs and their own agent-runs/<run>/checkpoints.sqlite.
import { workflowGraph } from './workflow.mjs';
export const graph = workflowGraph().compile();
graph.name = 'wiggly-my-pixar-story';
