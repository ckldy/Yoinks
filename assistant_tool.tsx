import { readMinimalLog } from "./services/logs"

AssistantTool.registerExecuteTool(async () => {
  const events = (await readMinimalLog()).slice(-100)
  const text = events.length
    ? JSON.stringify({ eventCount: events.length, events }, null, 2)
    : "尚无 Yoinks 运行日志。"
  return {
    success: true,
    output: {
      assistantParts: [{ type: "text", text }],
    },
  }
})
