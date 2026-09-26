import { z } from "zod";

/** The only protocol accepted from the tester LLM. */
export const testerResultSchema = z
  .object({
    passed: z.boolean(),
    summary: z.string().min(1),
    testsRun: z.array(z.string().min(1)),
    failures: z.array(z.string().min(1)),
    warnings: z.array(z.string().min(1)),
    changedFiles: z.array(z.string().min(1)),
    suggestedFixes: z.array(z.string().min(1)),
  })
  .strict();

export type TesterResult = z.infer<typeof testerResultSchema>;
