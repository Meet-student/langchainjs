import { OpenAI as OpenAIClient } from "openai";

import { ToolDefinition } from "@langchain/core/language_models/base";
import { BindToolsInput } from "@langchain/core/language_models/chat_models";
import {
  convertToOpenAITool as formatToOpenAITool,
  isLangChainTool,
} from "@langchain/core/utils/function_calling";
import { StructuredToolInterface } from "@langchain/core/tools";
import { isInteropZodSchema } from "@langchain/core/utils/types";
import { toJsonSchema } from "@langchain/core/utils/json_schema";

/**
 * Formats a tool in either OpenAI format, or LangChain structured tool format
 * into an OpenAI tool format. If the tool is already in OpenAI format, return without
 * any changes. If it is in LangChain structured tool format, convert it to OpenAI tool format
 * using OpenAI's `zodFunction` util, falling back to `convertToOpenAIFunction` if the parameters
 * returned from the `zodFunction` util are not defined.
 *
 * @param {BindToolsInput} tool The tool to convert to an OpenAI tool.
 * @param {Object} [fields] Additional fields to add to the OpenAI tool.
 * @returns {ToolDefinition} The inputted tool in OpenAI tool format.
 */
export function _convertToOpenAITool(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool: BindToolsInput,
  fields?: {
    /**
     * If `true`, model output is guaranteed to exactly match the JSON Schema
     * provided in the function definition.
     */
    strict?: boolean;
  }
): OpenAIClient.ChatCompletionTool {
  let toolDef: OpenAIClient.ChatCompletionTool | undefined;

  if (isLangChainTool(tool)) {
    toolDef = formatToOpenAITool(tool);
  } else {
    toolDef = tool as ToolDefinition;
  }

  if (fields?.strict !== undefined) {
    toolDef.function.strict = fields.strict;
  }

  return toolDef;
}

type OpenAIFunction = OpenAIClient.Chat.ChatCompletionCreateParams.Function;

// Types representing the OpenAI function definitions. While the OpenAI client library
// does have types for function definitions, the properties are just Record<string, unknown>,
// which isn't very useful for type checking this formatting code.
export interface FunctionDef extends Omit<OpenAIFunction, "parameters"> {
  name: string;
  description?: string;
  parameters: ObjectProp;
}

interface ObjectProp {
  type: "object";
  properties?: {
    [key: string]: Prop;
  };
  required?: string[];
}

interface AnyOfProp {
  anyOf: Prop[];
}

type Prop = {
  description?: string;
} & (
  | AnyOfProp
  | ObjectProp
  | {
      type: "string";
      enum?: string[];
    }
  | {
      type: "number" | "integer";
      minimum?: number;
      maximum?: number;
      enum?: number[];
    }
  | { type: "boolean" }
  | { type: "null" }
  | {
      type: "array";
      items?: Prop;
    }
);

function isAnyOfProp(prop: Prop): prop is AnyOfProp {
  return (
    (prop as AnyOfProp).anyOf !== undefined &&
    Array.isArray((prop as AnyOfProp).anyOf)
  );
}

// When OpenAI use functions in the prompt, they format them as TypeScript definitions rather than OpenAPI JSON schemas.
// This function converts the JSON schemas into TypeScript definitions.
export function formatFunctionDefinitions(functions: FunctionDef[]) {
  const lines = ["namespace functions {", ""];
  for (const f of functions) {
    if (f.description) {
      lines.push(`// ${f.description}`);
    }
    if (Object.keys(f.parameters.properties ?? {}).length > 0) {
      lines.push(`type ${f.name} = (_: {`);
      lines.push(formatObjectProperties(f.parameters, 0));
      lines.push("}) => any;");
    } else {
      lines.push(`type ${f.name} = () => any;`);
    }
    lines.push("");
  }
  lines.push("} // namespace functions");
  return lines.join("\n");
}

// Format just the properties of an object (not including the surrounding braces)
function formatObjectProperties(obj: ObjectProp, indent: number): string {
  const lines: string[] = [];
  for (const [name, param] of Object.entries(obj.properties ?? {})) {
    if (param.description && indent < 2) {
      lines.push(`// ${param.description}`);
    }
    if (obj.required?.includes(name)) {
      lines.push(`${name}: ${formatType(param, indent)},`);
    } else {
      lines.push(`${name}?: ${formatType(param, indent)},`);
    }
  }
  return lines.map((line) => " ".repeat(indent) + line).join("\n");
}

// Format a single property type
function formatType(param: Prop, indent: number): string {
  if (isAnyOfProp(param)) {
    return param.anyOf.map((v) => formatType(v, indent)).join(" | ");
  }
  switch (param.type) {
    case "string":
      if (param.enum) {
        return param.enum.map((v) => `"${v}"`).join(" | ");
      }
      return "string";
    case "number":
      if (param.enum) {
        return param.enum.map((v) => `${v}`).join(" | ");
      }
      return "number";
    case "integer":
      if (param.enum) {
        return param.enum.map((v) => `${v}`).join(" | ");
      }
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "object":
      return ["{", formatObjectProperties(param, indent + 2), "}"].join("\n");
    case "array":
      if (param.items) {
        return `${formatType(param.items, indent)}[]`;
      }
      return "any[]";
    default:
      return "";
  }
}

export function formatToOpenAIAssistantTool(
  tool: StructuredToolInterface
): ToolDefinition {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: isInteropZodSchema(tool.schema)
        ? toJsonSchema(tool.schema)
        : tool.schema,
    },
  };
}

export type OpenAIToolChoice =
  | OpenAIClient.ChatCompletionToolChoiceOption
  | "any"
  | string;

export type ResponsesToolChoice = NonNullable<
  OpenAIClient.Responses.ResponseCreateParams["tool_choice"]
>;

export type ChatOpenAIToolType =
  | BindToolsInput
  | OpenAIClient.Chat.ChatCompletionTool
  | ResponsesTool;

export type ResponsesTool = NonNullable<
  OpenAIClient.Responses.ResponseCreateParams["tools"]
>[number];

export function formatToOpenAIToolChoice(
  toolChoice?: OpenAIToolChoice
): OpenAIClient.ChatCompletionToolChoiceOption | undefined {
  if (!toolChoice) {
    return undefined;
  } else if (toolChoice === "any" || toolChoice === "required") {
    return "required";
  } else if (toolChoice === "auto") {
    return "auto";
  } else if (toolChoice === "none") {
    return "none";
  } else if (typeof toolChoice === "string") {
    return {
      type: "function",
      function: {
        name: toolChoice,
      },
    };
  } else {
    return toolChoice;
  }
}

export function isBuiltInTool(tool: ChatOpenAIToolType): tool is ResponsesTool {
  return "type" in tool && tool.type !== "function";
}

export function isBuiltInToolChoice(
  tool_choice: OpenAIToolChoice | ResponsesToolChoice | undefined
): tool_choice is ResponsesToolChoice {
  return (
    tool_choice != null &&
    typeof tool_choice === "object" &&
    "type" in tool_choice &&
    tool_choice.type !== "function"
  );
}
