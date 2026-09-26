import {
  projectPlanSchema,
  validateFoundationTask,
  validateProjectPlan,
} from "../../src/domain/plan.js";
import { createTaskState } from "../../src/domain/scheduler.js";

function testValidPlan() {
  const plan = {
    goal: "Test project",
    architecture: {
      runtime: "Node.js",
      storage: "in-memory",
      apiBasePath: "/tasks",
      frontend: "plain JavaScript",
      fileLayout: ["server.js", "public/", "tests/"],
      testCommand: "npm test",
    },

    tasks: [
      {
        id: "foundation",
        title: "Foundation",
        description: "Choose the stack, API contract, file layout, and test command.",
        owner: "backend" as const,
        dependencies: [],
      },
      {
        id: "task-2",
        title: "Backend",
        description: "Create backend",
        owner: "backend" as const,
        dependencies: ["foundation"],
      },
      {
        id: "task-3",
        title: "Frontend",
        description: "Create frontend",
        owner: "frontend" as const,
        dependencies: ["foundation"],
      },
    ],
  };

  const parsed = projectPlanSchema.parse(plan);
  const validated = validateFoundationTask(validateProjectPlan(parsed));
  const scheduledTasks = createTaskState(validated);

  if (!scheduledTasks.every((task) => task.architecture === validated.architecture)) {
    throw new Error("Shared architecture contract was not passed to every task");
  }

  console.log("✅ Valid plan passed");
}

function testMissingArchitectureContract() {
  const plan = {
    goal: "Invalid project",
    tasks: [
      {
        id: "foundation",
        title: "Foundation",
        description: "Choose stack and API contract.",
        owner: "backend" as const,
        dependencies: [],
      },
    ],
  };

  try {
    validateFoundationTask(validateProjectPlan(projectPlanSchema.parse(plan)));
    console.log("❌ Missing architecture contract was not detected");
  } catch (error) {
    console.log("✅ Missing architecture contract detected");
    console.log(String(error));
  }
}

function testMissingFoundationDependency() {
  const plan = {
    goal: "Invalid project",
    architecture: {
      runtime: "Node.js",
      storage: "in-memory",
      apiBasePath: "/tasks",
      frontend: "plain JavaScript",
      fileLayout: ["server.js"],
      testCommand: "npm test",
    },
    tasks: [
      {
        id: "foundation",
        title: "Foundation",
        description: "Choose stack and API contract.",
        owner: "backend" as const,
        dependencies: [],
      },
      {
        id: "frontend",
        title: "Frontend",
        description: "Build the UI.",
        owner: "frontend" as const,
        dependencies: [],
      },
    ],
  };

  try {
    validateFoundationTask(validateProjectPlan(projectPlanSchema.parse(plan)));
    console.log("❌ Missing foundation dependency was not detected");
  } catch (error) {
    console.log("✅ Missing foundation dependency detected");
    console.log(String(error));
  }
}

function testUnknownDependency() {
  const plan = {
    goal: "Invalid project",

    tasks: [
      {
        id: "task-1",
        title: "Backend",
        description: "Create backend",
        owner: "backend" as const,
        dependencies: ["task-999"],
      },
    ],
  };

  try {
    const parsed = projectPlanSchema.parse(plan);
    validateProjectPlan(parsed);

    console.log("❌ Unknown dependency was not detected");
  } catch (error) {
    console.log("✅ Unknown dependency detected");
    console.log(String(error));
  }
}

function testSelfDependency() {
  const plan = {
    goal: "Invalid project",

    tasks: [
      {
        id: "task-1",
        title: "Backend",
        description: "Create backend",
        owner: "backend" as const,
        dependencies: ["task-1"],
      },
    ],
  };

  try {
    const parsed = projectPlanSchema.parse(plan);
    validateProjectPlan(parsed);

    console.log("❌ Self dependency was not detected");
  } catch (error) {
    console.log("✅ Self dependency detected");
    console.log(String(error));
  }
}

function testDuplicateIds() {
  const plan = {
    goal: "Invalid project",

    tasks: [
      {
        id: "task-1",
        title: "Backend",
        description: "Create backend",
        owner: "backend" as const,
        dependencies: [],
      },
      {
        id: "task-1",
        title: "Frontend",
        description: "Create frontend",
        owner: "frontend" as const,
        dependencies: [],
      },
    ],
  };

  try {
    const parsed = projectPlanSchema.parse(plan);
    validateProjectPlan(parsed);

    console.log("❌ Duplicate IDs were not detected");
  } catch (error) {
    console.log("✅ Duplicate IDs detected");
    console.log(String(error));
  }
}

function testCircularDependency() {
  const plan = {
    goal: "Invalid project",

    tasks: [
      {
        id: "task-1",
        title: "Backend",
        description: "Create backend",
        owner: "backend" as const,
        dependencies: ["task-2"],
      },
      {
        id: "task-2",
        title: "Frontend",
        description: "Create frontend",
        owner: "frontend" as const,
        dependencies: ["task-3"],
      },
      {
        id: "task-3",
        title: "Tests",
        description: "Run tests",
        owner: "tester" as const,
        dependencies: ["task-1"],
      },
    ],
  };

  try {
    const parsed = projectPlanSchema.parse(plan);
    validateProjectPlan(parsed);

    console.log("❌ Circular dependency was not detected");
  } catch (error) {
    console.log("✅ Circular dependency detected");
    console.log(String(error));
  }
}

function main() {
  console.log("\n=== PLANNER VALIDATION TESTS ===\n");

  testValidPlan();

  console.log();
  testMissingFoundationDependency();

  console.log();
  testMissingArchitectureContract();

  console.log();
  testUnknownDependency();

  console.log();
  testSelfDependency();

  console.log();
  testDuplicateIds();

  console.log();
  testCircularDependency();
}

main();
