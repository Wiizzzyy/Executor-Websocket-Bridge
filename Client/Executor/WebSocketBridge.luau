local HOST = "localhost"
local PORT = 8080
local SECURE = false -- Only if for some reason you decide to host it publicly with https or sum stupid
local LOAD_DELAY = 1

local HEARTBEAT_INTERVAL = 5
local URL = `w{SECURE and 'ss' or 's'}://{HOST}:{PORT}`
local ws

local handlers = {
    execute = function(msg)
        local func, err = loadstring(msg.code)
        Send({
            type = "executed",
            error = err
        })
        if func then
            task.spawn(func)
        end
    end,

    ping = function(msg)
        Send({ type = "pong"  })
    end
}


function Send(data)
    pcall(function()
        ws:Send(game:GetService("HttpService"):JSONEncode(data))
    end)
end


local function HandleMessage(message)
    local success, data = pcall(function()
        return game:GetService("HttpService"):JSONDecode(message)
    end)

    if not success then
        return
    end

    local handler = handlers[data.type]

    if handler then
        pcall(function()
            handler(data)
        end)
    end
end


local function Heartbeat()
    while true do
        task.wait(HEARTBEAT_INTERVAL)
        Send({ type = "ping" })
    end
end

local function Connect()
    local success, err = pcall(function()
        ws = WebSocket.connect(URL)
        ws.OnMessage:Connect(function(message)
            HandleMessage(message)
        end)
        local exec, ver = identifyexecutor()
        local player = game:GetService("Players").LocalPlayer
        Send({
            type = "register",
            role = "executor",
            executor = exec,
            version = ver,
            account = `{player.DisplayName} (@{player.Name})`,
            place = game.PlaceId,
            job = game.JobId
        })
    end)
end

task.wait(LOAD_DELAY)

task.spawn(Connect)
task.spawn(Heartbeat)
