"""Local-only OpenCode integration fixture; never use as an inference endpoint.

Run with Python 3.11+: mock-provider.py TEST_DIRECTORY PORT
TEST_DIRECTORY/mode selects recover, cap, or normal. Only counters/settings are logged.
"""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

directory = Path(sys.argv[1]).resolve()
port = int(sys.argv[2])


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        mode = (directory / "mode").read_text().strip()
        messages = request.get("messages", [])
        corrected = any(
            message.get("role") == "user"
            and "次自动恢复" in json.dumps(message.get("content"), ensure_ascii=False)
            for message in messages
        )
        has_tool_result = any(message.get("role") == "tool" for message in messages)
        with (directory / "requests.jsonl").open("a") as out:
            out.write(json.dumps({"mode": mode, "corrected": corrected,
                                  "has_tool_result": has_tool_result,
                                  "reasoning_effort": request.get("reasoning_effort"),
                                  "max_tokens": request.get("max_tokens")}) + "\n")
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()

        def emit(value):
            self.wfile.write(("data: " + json.dumps(value) + "\n\n").encode())
            self.wfile.flush()

        def chunk(delta, finish=None):
            emit({"id": "chatcmpl-ninfer-recovery-fixture", "object": "chat.completion.chunk",
                  "created": int(time.time()), "model": request["model"],
                  "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]})

        if mode == "cap" or (mode == "recover" and not corrected):
            emit({"error": {"type": "server_error", "code": "tool_call_parse_error",
                            "message": "tool_call_parse_error: invalid tool call; no calls dispatched",
                            "param": None}})
        else:
            chunk({"role": "assistant"})
            if mode == "recover" and not has_tool_result:
                args = {"path": str(directory / "recovery-ok.txt"),
                        "content": "real OpenCode write tool completed after corrective retry\n"}
                chunk({"tool_calls": [{"index": 0, "id": "call_recovery_write",
                                       "type": "function", "function": {
                                           "name": "write", "arguments": json.dumps(args)}}]})
                chunk({}, "tool_calls")
            else:
                chunk({"content": "Validation finished. Example text: `tool_call_parse_error <tool_call>`"})
                chunk({}, "stop")
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        self.close_connection = True


ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
