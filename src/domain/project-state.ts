export type Task = {
  id: string;
  title: string;
  description: string;
  dependencies: string[];
  owner: "backend" | "frontend" | "tester" | "reviewer";
  status: "pending" | "running" | "done" | "failed";
};

export type ProjectState = {
  userRequest: string;

  architecture?: string;

  tasks: Task[];

  changedFiles: string[];

  testResults: string[];

  review?: string;

  errors: string[];
};
