local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local RS = game:GetService("ReplicatedStorage")

local PROXY   = "https://roblox-phone.vercel.app/api/phone"
local VPROXY  = "https://roblox-phone.onrender.com"
local VKEY    = "12345"

local ALLOWED = {
	yt=true, shorts=true, google=true, wiki=true, ai=true,
	weather=true, crypto=true, dict=true, pokemon=true, trivia=true,
}

local rf  = RS:WaitForChild("Mn")
local vrf = RS:WaitForChild("MnVideo")

local function getJson(url)
	local ok, body = pcall(HttpService.GetAsync, HttpService, url)
	if not ok then return { error = "network" } end
	local ok2, data = pcall(HttpService.JSONDecode, HttpService, body)
	if not ok2 then return { error = "bad json" } end
	return data
end

local function toBuffer(b64)
	if type(b64) ~= "string" or b64 == "" then return nil end
	local ok, raw = pcall(HttpService.Base64Decode, HttpService, b64)
	if not ok then return nil end
	return buffer.fromstring(raw)
end

-- keep Render awake (every 4 minutes)
task.spawn(function()
	while true do
		pcall(HttpService.GetAsync, HttpService, VPROXY .. "/health")
		task.wait(240)
	end
end)

local last = {}
rf.OnServerInvoke = function(plr, app, q, m)
	if typeof(app) ~= "string" or not ALLOWED[app] then return nil end
	q = tostring(q or ""):sub(1, 200)
	local now = os.clock()
	if last[plr] and now - last[plr] < 0.4 then return { error = "slow down" } end
	last[plr] = now
	local url = PROXY .. "?app=" .. app .. "&q=" .. HttpService:UrlEncode(q)
	if m then url = url .. "&m=" .. HttpService:UrlEncode(m) end
	return getJson(url)
end

local vlast = {}
vrf.OnServerInvoke = function(plr, action, arg1, arg2, arg3)
	local now = os.clock()
	if vlast[plr] and now - vlast[plr] < 0.15 then return { error = "slow" } end
	vlast[plr] = now

	if action == "img" then
		local url, w, h = arg1, tonumber(arg2) or 128, tonumber(arg3) or 128
		if typeof(url) ~= "string" or not url:match("^https://") then return nil end
		w = math.clamp(w, 32, 256)
		h = math.clamp(h, 32, 256)
		local data = getJson(string.format("%s/img?url=%s&w=%d&h=%d&k=%s",
			VPROXY, HttpService:UrlEncode(url), w, h, HttpService:UrlEncode(VKEY)))
		if data.error then return { error = data.error } end
		return { w = data.w, h = data.h, data = toBuffer(data.data) }
	end
	return nil
end

Players.PlayerRemoving:Connect(function(p)
	last[p] = nil
	vlast[p] = nil
end)
