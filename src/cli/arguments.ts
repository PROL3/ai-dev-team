export function parseWorkflowArguments(args: string[]): {
  projectRoot: string;
  request: string;
  resume: boolean;
  retryFailed?: boolean;
} {
  const leadingResume = args[0] === "--resume";
  const projectRoot = args[leadingResume ? 1 : 0];
  const rest = args.slice(leadingResume ? 2 : 1);
  const resume = leadingResume || rest[0] === "--resume";
  const flags = leadingResume ? rest : rest.slice(1);
  const retryFailed = resume && flags.length === 1 && flags[0] === "--retry-failed";
  if (
    !projectRoot ||
    projectRoot.startsWith("--") ||
    (resume && flags.length > 0 && !retryFailed) ||
    (!resume && rest.includes("--retry-failed"))
  ) {
    throw new Error(
      'Usage: npm start -- <project-directory> "<request>" OR npm start -- <project-directory> --resume [--retry-failed]',
    );
  }
  return {
    projectRoot,
    request: resume ? "" : rest.join(" ").trim(),
    resume,
    ...(retryFailed ? { retryFailed: true } : {}),
  };
}
