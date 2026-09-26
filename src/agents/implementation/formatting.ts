export function errorToMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || "Unknown Error";
  }

  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object") {
    try {
      const serialized = JSON.stringify(error);

      if (serialized && serialized !== "{}") {
        return serialized;
      }
    } catch {
      // Ignore JSON serialization failures.
    }
  }

  return "Unknown error";
}

export function excerpt(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const half = Math.floor((limit - 32) / 2);
  return `${value.slice(0, half)}\n[...truncated...]\n${value.slice(-half)}`;
}
