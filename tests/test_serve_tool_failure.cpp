#include "serve/tool_call_parser.h"

#include <iostream>
#include <string>
#include <vector>

using namespace ninfer::serve;

int main() {
    int failures = 0;
    const auto check = [&](bool ok, const char* message) {
        if (!ok) { std::cerr << "FAIL: " << message << '\n'; ++failures; }
    };
    const std::vector<std::string> tools{"write", "read"};
    const std::string body = "<tool_call>\n<function=write>\n<parameter=content>\n"
                             "export const example = true;\n</parameter>\n"
                             "<parameter=path>\n/tmp/example.ts\n</parameter>\n</function>";
    const std::string complete = body + "\n</tool_call>";
    const auto expect_error = [&](const std::string& text) {
        try {
            (void)parse_qwen_tool_call_output(text, 64, tools);
            check(false, "invalid attempted tool call returned success");
        } catch (const ApiException& exception) {
            check(exception.error().status == 502, "wrong HTTP status");
            check(exception.error().code == "tool_call_parse_error", "wrong stable error code");
            check(exception.error().type == "server_error", "wrong error type");
            check(exception.error().message.find("export const") == std::string::npos,
                  "error included private generated content");
        }
    };
    expect_error(body);
    expect_error("Writing now:\n\n" + body);
    expect_error(complete + "\n" + body); // Never dispatch a partial batch.
    expect_error("<tool_call>\n<function=write>\n<parameter=content>unfinished");
    expect_error("<tool_call>\n<function=write>\n</tool_call>");

    const auto valid = parse_qwen_tool_call_output("Writing now:\n" + complete, 64, tools);
    check(valid.is_tool_call_response && valid.tool_calls.size() == 1,
          "valid tool call changed");
    check(valid.content == "Writing now:", "valid introduction changed");
    const auto multiple = parse_qwen_tool_call_output(complete + "\n" + complete, 64, tools);
    check(multiple.tool_calls.size() == 2, "valid multi-call batch changed");

    const std::vector<std::string> answers{
        "Task complete.",
        "Example: `" + body + "`",
        "```xml\n" + body + "\n```",
        "~~~xml\n" + body + "\n~~~",
        "````xml\n```\n" + body + "\n```\n````",
        "> <tool_call>\n> <function=write>\n> incomplete example",
        "    <tool_call>\n    <function=write>\n    indented example",
        "\t<tool_call>\n\t<function=write>\n\tindented example",
        "<tool_call>\n<function=not_advertised>\n</function>",
        "The literal <tool_call> marks a tool call.",
    };
    for (const auto& answer : answers) {
        try {
            const auto parsed = parse_qwen_tool_call_output(answer, 64, tools);
            check(!parsed.is_tool_call_response && parsed.content == answer,
                  "ordinary/example text changed");
        } catch (...) { check(false, "ordinary/example text raised tool failure"); }
    }
    check(parse_qwen_tool_call_output(body, 64).content == body,
          "no-active-tools fallback changed");

    // Exercise every two-chunk split of the real failure shape: the service parses
    // before flushing the filter, so the failed call must never become visible text.
    const std::string incident = "Writing now:\n" + body;
    for (std::size_t split = 0; split <= incident.size(); ++split) {
        ToolCallStreamFilter filter;
        std::string visible = filter.feed(std::string_view(incident).substr(0, split));
        visible += filter.feed(std::string_view(incident).substr(split));
        bool failed = false;
        try {
            const auto parsed = parse_qwen_tool_call_output(incident, 64, tools);
            visible += filter.finish(parsed.is_tool_call_response);
        } catch (const ApiException&) { failed = true; }
        check(failed && visible == "Writing now:", "stream flushed failed tool content");
    }
    if (!failures) { std::cout << "serve tool-failure contracts passed\n"; }
    return failures ? 1 : 0;
}
