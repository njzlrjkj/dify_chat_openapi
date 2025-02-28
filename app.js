// 导入所需的模块
import express from "express"; // 使用Express框架创建Web服务器
import bodyParser from "body-parser"; // 用于解析请求体
import dotenv from "dotenv"; // 加载环境变量
import fetch from "node-fetch"; // 用于发起HTTP请求
dotenv.config(); // 初始化环境变量配置

// 环境变量校验
if (!process.env.DIFY_API_URL) throw new Error("DIFY API URL is required."); // 必须配置DIFY API地址

// 生成随机ID的工具函数（29位字母数字组合）
function generateId() {
  let result = "";
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 29; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

// 初始化Express应用
const app = express();
app.use(bodyParser.json()); // 使用JSON解析中间件

// 从环境变量读取配置
const botType = process.env.BOT_TYPE || 'Chat'; // 机器人类型（默认Chat）
const inputVariable = process.env.INPUT_VARIABLE || ''; // 输入变量名
const outputVariable = process.env.OUTPUT_VARIABLE || ''; // 输出变量名

// 根据机器人类型确定API路径
let apiPath;
switch (botType) {
  case 'Chat':
    apiPath = '/chat-messages'; // 聊天模式
    break;
  case 'Completion':
    apiPath = '/completion-messages'; // 补全模式
    break;
  case 'Workflow':
    apiPath = '/workflows/run'; // 工作流模式
    break;
  default:
    throw new Error('Invalid bot type in the environment variable.'); // 无效类型报错
}

// CORS跨域配置
var corsHeaders = {
  "Access-Control-Allow-Origin": "*", // 允许所有域名
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS", // 允许的HTTP方法
  "Access-Control-Allow-Headers": "DNT,User-Agent,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Range,Authorization", // 允许的请求头
  "Access-Control-Max-Age": "86400", // 预检请求缓存时间
};

// 全局中间件：设置CORS头并处理OPTIONS预检请求
app.use((req, res, next) => {
  res.set(corsHeaders); // 设置CORS响应头
  if (req.method === 'OPTIONS') { // 处理OPTIONS请求
    return res.status(204).end();
  }
  console.log('Request Method:', req.method);  // 记录请求方法
  console.log('Request Path:', req.path); // 记录请求路径
  next(); // 继续处理后续中间件
});

// 根路由：返回基础页面
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>DIFY2OPENAI</title>
      </head>
      <body>
        <h1>Dify2OpenAI</h1>
        <p>Congratulations! Your project has been successfully deployed.</p>
      </body>
    </html>
  `);
});

// 模型列表接口（兼容OpenAI格式）
app.get('/v1/models', (req, res) => {
  const models = {
    "object": "list",
    "data": [{
      "id": process.env.MODELS_NAME || "dify", // 从环境变量获取模型名称
      "object": "model",
      "owned_by": "dify",
      "permission": null,
    }]
  };
  res.json(models); // 返回模型信息
});

// 核心接口：处理聊天补全请求
app.post("/v1/chat/completions", async (req, res) => {
  // 认证头校验
  const authHeader = req.headers["authorization"] || req.headers["Authorization"];
  if (!authHeader) { // 无认证头时返回401
    return res.status(401).json({ code: 401, errmsg: "Unauthorized." });
  } else {
    const token = authHeader.split(" ")[1]; // 提取Bearer Token
    if (!token) { // Token不存在时返回401
      return res.status(401).json({ code: 401, errmsg: "Unauthorized." });
    }
  }
  
  try {
    const data = req.body; // 获取请求体
    const messages = data.messages; // 提取消息列表
    
    // 构建查询字符串（根据不同机器人类型）
    let queryString;
    if (botType === 'Chat') {
      // 拼接历史消息和最后一条消息
      const lastMessage = messages[messages.length - 1];
      queryString = `here is our talk history:\n'''\n${messages
        .slice(0, -1)
        .map((message) => `${message.role}: ${message.content}`)
        .join('\n')}\n'''\n\nhere is my question:\n${lastMessage.content}`;
    } else if (botType === 'Completion' || botType === 'Workflow') {
      // 直接使用最后一条消息
      queryString = messages[messages.length - 1].content;
    }

    // 判断是否流式响应
    const stream = data.stream !== undefined ? data.stream : false;
    
    // 构建请求体（根据不同输入变量配置）
    let requestBody;
    if (inputVariable) {
      requestBody = {
        inputs: { [inputVariable]: queryString }, // 使用指定输入变量
        response_mode: "streaming", // 流式响应模式
        conversation_id: "", // 空会话ID
        user: "apiuser", // 固定用户标识
        auto_generate_name: false // 不自动生成名称
      };
    } else {
      requestBody = {
        "inputs": {},
        query: queryString, // 直接使用query字段
        response_mode: "streaming",
        conversation_id: "",
        user: "apiuser",
        auto_generate_name: false
      };
    }

    // 调用Dify API
    const resp = await fetch(process.env.DIFY_API_URL + apiPath, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authHeader.split(" ")[1]}`, // 传递认证Token
      },
      body: JSON.stringify(requestBody),
    });

    let isResponseEnded = false; // 标记响应是否已结束

    // 流式响应处理
    if (stream) {
      res.setHeader("Content-Type", "text/event-stream"); // 设置事件流格式
      const stream = resp.body;
      let buffer = ""; // 数据缓冲区
      let isFirstChunk = true; // 标记首个数据块

      stream.on("data", (chunk) => {
        buffer += chunk.toString(); // 累积数据到缓冲区
        let lines = buffer.split("\n"); // 按换行分割

        // 处理每一行数据
        for (let i = 0; i < lines.length - 1; i++) {
          let line = lines[i].trim();
          if (!line.startsWith("data:")) continue; // 跳过非数据行
          
          line = line.slice(5).trim(); // 去除"data:"前缀
          let chunkObj;
          try {
            chunkObj = JSON.parse(line); // 解析JSON数据
          } catch (error) {
            console.error("Error parsing chunk:", error);
            continue;
          }

          // 处理不同事件类型
          if (chunkObj.event === "message" || chunkObj.event === "agent_message" || chunkObj.event === "text_chunk") {
            // 提取内容并处理首字符空格
            let chunkContent = chunkObj.event === "text_chunk" ? chunkObj.data.text : chunkObj.answer;
            if (isFirstChunk) {
              chunkContent = chunkContent.trimStart();
              isFirstChunk = false;
            }
            
            // 构造OpenAI格式的流式响应
            const chunkId = `chatcmpl-${Date.now()}`;
            res.write(`data: ${JSON.stringify({
              id: chunkId,
              object: "chat.completion.chunk",
              created: chunkObj.created_at,
              model: data.model,
              choices: [{
                index: 0,
                delta: { content: chunkContent },
                finish_reason: null,
              }],
            })}\n\n`);
            
          } else if (chunkObj.event === "workflow_finished" || chunkObj.event === "message_end") {
            // 结束流式响应
            const chunkId = `chatcmpl-${Date.now()}`;
            res.write(`data: ${JSON.stringify({
              id: chunkId,
              object: "chat.completion.chunk",
              created: chunkObj.created_at,
              model: data.model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            })}\n\n`);
            res.write("data: [DONE]\n\n"); // 发送结束标记
            res.end();
            isResponseEnded = true;
          } else if (chunkObj.event === "error") {
            // 错误处理
            console.error(`Error: ${chunkObj.code}, ${chunkObj.message}`);
            res.status(500).write(`data: ${JSON.stringify({ error: chunkObj.message })}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
            isResponseEnded = true;
          }
        }
        buffer = lines[lines.length - 1]; // 保留未处理完的数据
      });
      
    // 非流式响应处理
    } else {
      let result = ""; // 最终结果
      let usageData = ""; // 使用量数据
      let hasError = false; // 错误标记
      let messageEnded = false; // 消息结束标记
      let buffer = ""; // 数据缓冲区

      const stream = resp.body;
      stream.on("data", (chunk) => {
        buffer += chunk.toString();
        let lines = buffer.split("\n");

        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i].trim();
          if (line === "") continue;
          
          let chunkObj;
          try {
            chunkObj = JSON.parse(line.replace(/^data: /, "").trim()); // 清理并解析数据
          } catch (error) {
            console.error("Error parsing JSON:", error);
            continue;
          }

          // 处理不同事件类型
          if (chunkObj.event === "message" || chunkObj.event === "agent_message") {
            result += chunkObj.answer; // 累积结果
          } else if (chunkObj.event === "message_end") {
            messageEnded = true;
            usageData = chunkObj.metadata.usage; // 获取使用量数据
          } else if (chunkObj.event === "workflow_finished") {
            messageEnded = true;
            result = String(outputVariable ? chunkObj.data.outputs[outputVariable] : chunkObj.data.outputs); // 提取输出变量
            usageData = chunkObj.metadata?.usage || { // 获取使用量数据
              prompt_tokens: 100,
              completion_tokens: 10,
              total_tokens: 110
            };
          } else if (chunkObj.event === "error") {
            hasError = true; // 标记错误
          }
        }
        buffer = lines[lines.length - 1]; // 保留未处理数据
      });

      // 流结束处理
      stream.on("end", () => {
        if (hasError) {
          res.status(500).json({ error: "Processing error" }); // 返回错误
        } else if (messageEnded) {
          // 构造最终响应
          const formattedResponse = {
            id: `chatcmpl-${generateId()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: data.model,
            choices: [{
              message: { role: "assistant", content: result.trim() },
              finish_reason: "stop"
            }],
            usage: usageData,
            system_fingerprint: "fp_2f57f81c11" // 固定指纹
          };
          res.json(formattedResponse); // 发送响应
        } else {
          res.status(500).json({ error: "Unexpected stream end" }); // 意外结束
        }
      });
    }
  } catch (error) {
    console.error("Error:", error); // 全局错误处理
    res.status(500).json({ error: "Internal server error" });
  }
});

// 启动服务器
app.listen(process.env.PORT || 3011, () => {
  console.log(`Server running on port ${process.env.PORT || 3011}`);
});