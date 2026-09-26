import { planner } from "./agents/planner/planner.js";
import { Orchestrator } from "./workflow/orchestrator.js";
import {
  defaultCheckpointPath,
  WorkflowStore,
} from "./infrastructure/persistence/workflow-store.js";
import { parseWorkflowArguments } from "./cli/arguments.js";

const {
  projectRoot,
  request: userRequest,
  resume,
  retryFailed,
} = parseWorkflowArguments(process.argv.slice(2));

if (!resume && !userRequest) {
  throw new Error('Usage: npm start -- <project-directory> "<user request>"');
}

const checkpointPath = defaultCheckpointPath(projectRoot);
if (!resume && (await new WorkflowStore(checkpointPath).exists())) {
  throw new Error(
    `A saved run already exists. Resume it with: npm start -- "${projectRoot}" --resume`,
  );
}
const orchestrator = resume
  ? await Orchestrator.resume(projectRoot, { retryFailed: retryFailed ?? false })
  : new Orchestrator(await planner(userRequest), { projectRoot, checkpointPath });
console.log(`Workflow checkpoint: ${checkpointPath}`);

await orchestrator.runUntilComplete();

console.log("\nProject workflow completed:");
console.log(
  orchestrator.getAllTasks().map((task) => ({
    id: task.id,
    status: task.status,
  })),
);
