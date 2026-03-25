import { Type } from "@sinclair/typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyWwJSwDK2qWMs1cXxa7_s20EXhQ8prezmEIpuMvogZ21OiWxsnFFNPfGDoU2nL2c_q/exec";
const SCRIPT_TOKEN = "cultivata_tasks_2026_x8Kp9Qm2";

async function postToSheet(body: Record<string, unknown>) {
  const res = await fetch(SCRIPT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      token: SCRIPT_TOKEN,
      ...body,
    }),
  });

  const data = await res.json();

  if (!data.ok) {
    throw new Error(data.error || "Apps Script request failed");
  }

  return data;
}

export default definePluginEntry({
  name: "cultivata-google-sheets-task-tools",
  register(api) {
    api.registerTool(
      {
        name: "add_task",
        description: "Create a new task in Google Sheets",
        parameters: Type.Object({
          assignee: Type.String({ description: "Person responsible for the task" }),
          title: Type.String({ description: "Short task title" }),
          due_at: Type.Optional(Type.String({ description: "Datetime in YYYY-MM-DD HH:mm:ss if known" })),
          due_label: Type.Optional(Type.String({ description: "Human-readable due time like today 6pm" })),
          notes: Type.Optional(Type.String({ description: "Optional notes" })),
        }),
        async execute(_id, params) {
          const data = await postToSheet({
            action: "add_task",
            assignee: params.assignee,
            title: params.title,
            due_at: params.due_at || "",
            due_label: params.due_label || "",
            notes: params.notes || "",
          });

          const t = data.task;
          return {
            content: [
              {
                type: "text",
                text: `Added. ${t.assignee} — ${t.title} — due ${t.due_label || "no due date"}. Task ID: ${t.task_id}.`,
              },
            ],
          };
        },
      },
      { optional: true }
    );

    api.registerTool(
      {
        name: "list_tasks",
        description: "List tasks from Google Sheets",
        parameters: Type.Object({
          assignee: Type.Optional(Type.String({ description: "Optional assignee filter" })),
          status: Type.Optional(Type.String({ description: "Task status filter, usually pending" })),
        }),
        async execute(_id, params) {
          const data = await postToSheet({
            action: "list_tasks",
            assignee: params.assignee || "",
            status: params.status || "pending",
          });

          const tasks = data.tasks || [];
          const text =
            tasks.length === 0
              ? "No matching tasks."
              : tasks
                  .map(
                    (t: any) =>
                      `${t.task_id} — ${t.assignee} — ${t.title} — ${t.due_label || "no due date"} — ${t.status}`
                  )
                  .join("\n");

          return {
            content: [{ type: "text", text }],
          };
        },
      },
      { optional: true }
    );

    api.registerTool(
      {
        name: "complete_task",
        description: "Mark a task as completed in Google Sheets",
        parameters: Type.Object({
          task_id: Type.Optional(Type.String({ description: "Task ID like T001 if known" })),
          assignee: Type.Optional(Type.String({ description: "Assignee if task_id is not known" })),
          title: Type.Optional(Type.String({ description: "Task title if task_id is not known" })),
        }),
        async execute(_id, params) {
          const data = await postToSheet({
            action: "complete_task",
            task_id: params.task_id || "",
            assignee: params.assignee || "",
            title: params.title || "",
          });

          const t = data.task;
          return {
            content: [
              {
                type: "text",
                text: `Done. ${t.task_id} — ${t.assignee} — ${t.title} is marked complete.`,
              },
            ],
          };
        },
      },
      { optional: true }
    );
  },
});
