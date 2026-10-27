import readline from "node:readline";

export function createEventStream(cli, logger = console) {
  let stopped = false;
  let child = null;

  async function start(onEvent) {
    let retrySeconds = 1;
    while (!stopped) {
      child = cli.spawnEventConsumer();
      logger.info(`[event] consumer started pid=${child.pid}`);
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        const message = chunk.trim();
        if (message) logger.error(`[event] ${message}`);
      });

      const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        try {
          await onEvent(JSON.parse(line));
          retrySeconds = 1;
        } catch (error) {
          logger.error("[event] failed to handle message", error);
        }
      }

      const code = await new Promise((resolve) => {
        if (child.exitCode !== null) resolve(child.exitCode);
        else child.once("close", resolve);
      });
      if (stopped) break;
      logger.error(`[event] consumer exited code=${code}; retrying in ${retrySeconds}s`);
      await new Promise((resolve) => setTimeout(resolve, retrySeconds * 1000));
      retrySeconds = Math.min(retrySeconds * 2, 30);
    }
  }

  function stop() {
    stopped = true;
    child?.kill("SIGTERM");
  }

  return { start, stop };
}
