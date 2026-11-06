export function printOmniaStreamEvent(raw: string, _debug?: boolean): void {
  const line = raw.trim();
  if (!line) return;

  if (line.startsWith("[omnia:tool_call]")) {
    console.log(`\x1b[36m${line}\x1b[0m`);
    return;
  }
  if (line.startsWith("[omnia:tool_result]")) {
    console.log(`\x1b[32m${line}\x1b[0m`);
    return;
  }
  if (line.startsWith("[omnia:security]") || line.startsWith("[omnia:tools]")) {
    console.log(`\x1b[35m${line}\x1b[0m`);
    return;
  }
  if (line.startsWith("[omnia]")) {
    console.log(`\x1b[34m${line}\x1b[0m`);
    return;
  }

  process.stdout.write(raw);
}
