-- PhoneServer (type: Script) -> ServerScriptService
-- Needs RemoteFunctions in ReplicatedStorage named: Mn  and  Mn2  (MnVideo is also accepted)
local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local RS = game:GetService("ReplicatedStorage")

local PROXY  = "https://roblox-phone.vercel.app/api/phone"
local VPROXY = "https://roblox-phone.onrender.com"
local KEY    = "12345" -- CHANGE THIS. Must equal SECRET on Vercel and on Render.

local BLOCK_MSG = "Roblox is declining your search because it may be inappropriate for this system. This is not a bug!"

-- ================= TEXT FILTER =================
-- Part 1: long terms, blocked even when hidden inside a longer word
local STRICT = {
	"porn", "xvideos", "xhamster", "xnxx", "redtube", "youporn", "pornhub", "chaturbate", "stripchat", "brazzers",
	"onlyfans", "hentai", "nhentai", "nsfw", "nude", "naked", "nudity", "blowjob", "handjob", "footjob", "rimjob",
	"cumshot", "creampie", "gangbang", "bukkake", "deepthroat", "threesome", "orgy", "orgasm", "bdsm", "fetish",
	"dildo", "vibrator", "masturbat", "erotic", "erotica", "sexual", "sexy", "sexting", "nipple", "boob", "lolicon",
	"shotacon", "camgirl", "striptease", "stripper", "fuck", "motherfuck", "bitch", "cunt",
	"pedophil", "paedophil", "molest", "childporn", "jailbait", "playboy", "penthouse", "fapping", "jerkoff",
	"jackoff", "whore", "slut", "lewd", "ecchi", "genital", "pubic", "nsfl",
}
-- Part 2: short words, blocked only as a whole word (so "class" / "grape" / "Essex" stay fine)
local WORDS = {}
for _, w in ipairs({
	"sex", "sexes", "ass", "asses", "asshole", "anal", "cum", "cums", "cock", "cocks", "dick", "dicks", "pussy", "pussies",
	"tit", "tits", "titty", "titties", "vagina", "penis", "boobs", "horny", "rape", "raped", "rapist", "incest",
	"pedo", "pedos", "milf", "xxx", "porno", "smut", "naughty", "kink", "kinky", "thot",
	"semen", "sperm", "erection", "clit", "clitoris", "anus", "booty",
	"twerk", "lingerie", "topless", "bottomless", "nudes", "shit", "piss",
}) do WORDS[w] = true end
-- Part 3: raw patterns checked before any cleanup
local RAW = { "rule34", "rule 34", "r34", "e621", "18+", "18 +", "adult only", "adults only", "over 18", "onlyfan" }

local LEET = { ["0"] = "o", ["1"] = "i", ["3"] = "e", ["4"] = "a", ["5"] = "s", ["7"] = "t", ["@"] = "a", ["$"] = "s", ["!"] = "i", ["+"] = "t", ["8"] = "b" }

local function collapse(s) return (s:gsub("(%a)%1+", "%1")) end

local STRICT2 = {}
for _, t in ipairs(STRICT) do
	table.insert(STRICT2, t)
	local c = collapse(t)
	if c ~= t and #c >= 4 then table.insert(STRICT2, c) end
end

local function hitStrict(str)
	local c = collapse(str)
	for _, t in ipairs(STRICT2) do
		if str:find(t, 1, true) or c:find(t, 1, true) then return true end
	end
	return false
end

local function isBad(text)
	text = tostring(text or ""):lower()
	if text == "" then return false end
	for _, p in ipairs(RAW) do
		if text:find(p, 1, true) then return true end
	end
	local norm = text:gsub(".", function(c) return LEET[c] end)
	norm = norm:gsub("[^%a]", " ")
	local tokens, singles = {}, {}
	local run = ""
	for tok in norm:gmatch("%a+") do
		table.insert(tokens, tok)
		if #tok == 1 then
			run = run .. tok
		else
			if #run >= 3 then table.insert(singles, run) end
			run = ""
		end
	end
	if #run >= 3 then table.insert(singles, run) end
	for _, tok in ipairs(tokens) do
		if WORDS[tok] or WORDS[collapse(tok)] then return true end
		if hitStrict(tok) then return true end
	end
	-- "p o r n" style spaced-out letters
	for _, s in ipairs(singles) do
		if hitStrict(s) or WORDS[s] then return true end
	end
	-- glued words with symbols in between: "p.o.r.n" / "p_o_r_n"
	local glued = text:gsub(".", function(c) return LEET[c] end):gsub("[^%a]", "")
	if #glued <= 30 and hitStrict(glued) then return true end
	return false
end

-- spam control: 3 blocked tries inside 60s = everything search-like is blocked for 30s
local strikes, lockUntil = {}, {}
local function registerStrike(plr)
	local now = os.clock()
	local s = strikes[plr]
	if not s or now - s.t > 60 then s = { t = now, n = 0 } end
	s.n += 1
	strikes[plr] = s
	if s.n >= 3 then lockUntil[plr] = now + 30 end
end
local function blockedReply()
	return { error = BLOCK_MSG, blocked = true }
end

-- ================= HTTP HELPERS =================
local cache, cacheN = {}, 0
local function fetchRaw(url, fresh)
	if not fresh then
		local c = cache[url]
		if c and os.clock() - c.t < 30 then return c.v end
	end
	local full = PROXY .. "?app=fetch&k=" .. HttpService:UrlEncode(KEY) .. "&u=" .. HttpService:UrlEncode(url)
	if fresh then full = full .. "&r=" .. math.random(1, 1000000000) end
	local ok, body = pcall(HttpService.GetAsync, HttpService, full)
	if not ok then return nil end
	if not fresh then
		cacheN += 1
		if cacheN > 150 then cache, cacheN = {}, 0 end
		cache[url] = { t = os.clock(), v = body }
	end
	return body
end

local function fetchJson(url, fresh)
	local body = fetchRaw(url, fresh)
	if not body then return nil end
	local ok, d = pcall(HttpService.JSONDecode, HttpService, body)
	if ok then return d end
	return nil
end

local function viaProxy(app, q)
	local url = PROXY .. "?app=" .. app .. "&k=" .. HttpService:UrlEncode(KEY) .. "&q=" .. HttpService:UrlEncode(q)
	local ok, body = pcall(HttpService.GetAsync, HttpService, url)
	if not ok then return nil end
	local ok2, d = pcall(HttpService.JSONDecode, HttpService, body)
	if ok2 then return d end
	return nil
end

local function enc(s) return HttpService:UrlEncode(s) end
local function cut(v, n) return tostring(v or ""):sub(1, n or 200) end
local function clean(s)
	s = tostring(s or "")
	s = s:gsub("<[^>]+>", ""):gsub("&quot;", '"'):gsub("&#39;", "'"):gsub("&amp;", "&"):gsub("&lt;", "<"):gsub("&gt;", ">")
	return s
end
local function fmtNum(n)
	n = tonumber(n) or 0
	local s = tostring(math.floor(n))
	local out = s:reverse():gsub("(%d%d%d)", "%1,"):reverse()
	return (out:gsub("^,", ""))
end
local function fail(msg) return { error = msg } end

-- ================= FEEDS (each returns { items = {...} } ) =================
local H = {}

local function fromYT(app)
	return function(q)
		local d = viaProxy(app, q)
		if not d then return fail("Could not reach server") end
		local items = {}
		for _, v in ipairs(d.results or {}) do
			table.insert(items, { title = cut(v.title, 120), sub = cut(v.sub, 60), meta = cut(v.meta, 60), length = v.length, thumb = v.thumbnail })
		end
		if #items == 0 then return fail(d.note or "No results") end
		return { items = items }
	end
end
H.yt = fromYT("yt")
H.shorts = fromYT("shorts")

H.google = function(q)
	if q == "" then q = "roblox" end
	local d = viaProxy("google", q)
	if not d then return fail("Could not reach server") end
	local items = {}
	for _, v in ipairs(d.results or {}) do
		table.insert(items, { title = cut(v.title, 100), sub = cut(v.snippet, 220), meta = cut(v.url, 80) })
	end
	if #items == 0 then return fail(d.note or "No results") end
	return { items = items }
end

H.wiki = function(q)
	if q == "" then q = "Roblox" end
	local d = fetchJson("https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=12&srsearch=" .. enc(q))
	if not d or not d.query then return fail("Wikipedia unavailable") end
	local items = {}
	for _, r in ipairs(d.query.search or {}) do
		table.insert(items, { title = r.title, sub = cut(clean(r.snippet), 240), meta = "en.wikipedia.org/wiki/" .. r.title:gsub(" ", "_") })
	end
	if #items == 0 then return fail("No articles found") end
	return { items = items }
end

H.news = function(q)
	local url = (q == "") and "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=20"
		or ("https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=20&query=" .. enc(q))
	local d = fetchJson(url)
	if not d then return fail("Hacker News unavailable") end
	local items = {}
	for _, h in ipairs(d.hits or {}) do
		if h.title then
			local host = tostring(h.url or ""):match("^https?://([^/]+)") or "news.ycombinator.com"
			table.insert(items, { title = cut(h.title, 140), sub = host, meta = (h.points or 0) .. " points  -  " .. (h.num_comments or 0) .. " comments" })
		end
	end
	if #items == 0 then return fail("No stories found") end
	return { items = items }
end

local WMO = { [0] = "Clear sky", [1] = "Mostly clear", [2] = "Partly cloudy", [3] = "Overcast", [45] = "Fog", [48] = "Fog", [51] = "Light drizzle", [53] = "Drizzle", [55] = "Heavy drizzle", [61] = "Light rain", [63] = "Rain", [65] = "Heavy rain", [71] = "Light snow", [73] = "Snow", [75] = "Heavy snow", [80] = "Rain showers", [81] = "Rain showers", [82] = "Violent showers", [95] = "Thunderstorm", [96] = "Thunderstorm", [99] = "Thunderstorm" }
H.weather = function(q)
	if q == "" then q = "London" end
	local g = fetchJson("https://geocoding-api.open-meteo.com/v1/search?count=1&name=" .. enc(q))
	if not g or not g.results or not g.results[1] then return fail("City not found") end
	local c = g.results[1]
	local w = fetchJson("https://api.open-meteo.com/v1/forecast?latitude=" .. c.latitude .. "&longitude=" .. c.longitude ..
		"&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=5")
	if not w or not w.current then return fail("Weather unavailable") end
	local cur = w.current
	local items = { {
		title = c.name .. ", " .. tostring(c.country or ""),
		sub = math.floor(cur.temperature_2m + 0.5) .. " C  -  " .. (WMO[cur.weather_code] or "Unknown"),
		meta = "Humidity " .. cur.relative_humidity_2m .. "%  -  Wind " .. cur.wind_speed_10m .. " km/h",
	} }
	local dl = w.daily
	if dl and dl.time then
		for i, day in ipairs(dl.time) do
			table.insert(items, { title = day, sub = (WMO[dl.weather_code[i]] or ""), meta = "High " .. math.floor(dl.temperature_2m_max[i] + 0.5) .. " C  /  Low " .. math.floor(dl.temperature_2m_min[i] + 0.5) .. " C" })
		end
	end
	return { items = items }
end

H.crypto = function()
	local d = fetchJson("https://api.coinpaprika.com/v1/tickers?quotes=USD&limit=15")
	if not d then return fail("Crypto prices unavailable") end
	local items = {}
	for i, c in ipairs(d) do
		if i > 15 then break end
		local u = c.quotes and c.quotes.USD
		if u then
			local ch = u.percent_change_24h or 0
			table.insert(items, { title = c.name .. " (" .. c.symbol .. ")", sub = "$" .. string.format("%.2f", u.price or 0), meta = string.format("24h: %s%.2f%%", ch >= 0 and "+" or "", ch) })
		end
	end
	if #items == 0 then return fail("No data") end
	return { items = items }
end

H.currency = function(q)
	local base = (q ~= "" and q:upper():gsub("[^A-Z]", "")) or "USD"
	if #base ~= 3 then base = "USD" end
	local d = fetchJson("https://api.frankfurter.dev/v1/latest?base=" .. base)
	if not d or not d.rates then d = fetchJson("https://api.frankfurter.app/latest?from=" .. base) end
	if not d or not d.rates then return fail("Currency not found") end
	local keys = {}
	for k in pairs(d.rates) do table.insert(keys, k) end
	table.sort(keys)
	local items = { { title = "1 " .. base .. " equals", sub = "Rates from " .. tostring(d.date or ""), meta = "European Central Bank data" } }
	for _, k in ipairs(keys) do
		table.insert(items, { title = k, sub = tostring(d.rates[k]) })
	end
	return { items = items }
end

H.dict = function(q)
	if q == "" then q = "hello" end
	local d = fetchJson("https://api.dictionaryapi.dev/api/v2/entries/en/" .. enc(q:lower()))
	if not d or not d[1] or not d[1].meanings then return fail("Word not found") end
	local items = {}
	for i, m in ipairs(d[1].meanings) do
		if i > 4 then break end
		local df = m.definitions and m.definitions[1]
		if df then table.insert(items, { title = d[1].word .. "  (" .. tostring(m.partOfSpeech) .. ")", sub = cut(df.definition, 260), meta = df.example and ("Example: " .. cut(df.example, 160)) or "" }) end
	end
	if #items == 0 then return fail("Word not found") end
	return { items = items }
end

H.pokedex = function(q)
	if q == "" then q = "pikachu" end
	local d = fetchJson("https://pokeapi.co/api/v2/pokemon/" .. enc(q:lower():gsub("%s+", "-")))
	if not d or not d.name then return fail("Pokemon not found") end
	local types = {}
	for _, t in ipairs(d.types or {}) do table.insert(types, t.type.name) end
	local art = d.sprites and d.sprites.other and d.sprites.other["official-artwork"] and d.sprites.other["official-artwork"].front_default
	return { items = { {
		title = d.name:upper() .. "  #" .. d.id, sub = "Type: " .. table.concat(types, ", "),
		meta = "Height " .. (d.height / 10) .. " m  -  Weight " .. (d.weight / 10) .. " kg",
		img = art or (d.sprites and d.sprites.front_default), big = true,
	} } }
end

H.books = function(q)
	if q == "" then q = "science fiction" end
	local d = fetchJson("https://openlibrary.org/search.json?limit=15&fields=title,author_name,first_publish_year,cover_i&q=" .. enc(q))
	if not d or not d.docs then return fail("Open Library unavailable") end
	local items = {}
	for _, b in ipairs(d.docs) do
		table.insert(items, {
			title = cut(b.title, 100), sub = b.author_name and cut(b.author_name[1], 60) or "", meta = b.first_publish_year and ("First published " .. b.first_publish_year) or "",
			img = b.cover_i and ("https://covers.openlibrary.org/b/id/" .. b.cover_i .. "-M.jpg") or nil,
		})
	end
	if #items == 0 then return fail("No books found") end
	return { items = items }
end

local function itunes(kind)
	return function(q, defaultTerm)
		if q == "" then q = defaultTerm end
		local d = fetchJson("https://itunes.apple.com/search?limit=20&media=" .. kind.media .. "&term=" .. enc(q))
		if not d or not d.results then return fail("Catalog unavailable") end
		local items = {}
		for _, r in ipairs(d.results) do
			local art = r.artworkUrl100 or r.artworkUrl60
			if art then art = art:gsub("100x100", "200x200") end
			table.insert(items, {
				title = cut(r[kind.title] or r.trackName or r.collectionName, 100),
				sub = cut(kind.sub and r[kind.sub] or r.artistName, 80),
				meta = cut(kind.meta and r[kind.meta] or r.primaryGenreName, 90),
				img = art,
			})
		end
		if #items == 0 then return fail("Nothing found") end
		return { items = items }
	end
end
local iMusic = itunes({ media = "music", title = "trackName", sub = "artistName", meta = "collectionName" })
local iMovie = itunes({ media = "movie", title = "trackName", sub = "artistName", meta = "primaryGenreName" })
local iPod = itunes({ media = "podcast", title = "collectionName", sub = "artistName", meta = "primaryGenreName" })
H.music = function(q) return iMusic(q, "pop hits") end
H.movies = function(q) return iMovie(q, "action") end
H.podcasts = function(q) return iPod(q, "news") end

H.recipes = function(q)
	if q == "" then q = "chicken" end
	local d = fetchJson("https://www.themealdb.com/api/json/v1/1/search.php?s=" .. enc(q))
	if not d or not d.meals then return fail("No recipes found") end
	local items = {}
	for i, m in ipairs(d.meals) do
		if i > 10 then break end
		table.insert(items, { title = m.strMeal, sub = cut(m.strInstructions, 330), meta = tostring(m.strCategory) .. "  -  " .. tostring(m.strArea), img = m.strMealThumb and (m.strMealThumb .. "/preview") or nil })
	end
	return { items = items }
end

H.cocktails = function(q)
	if q == "" then q = "margarita" end
	local d = fetchJson("https://www.thecocktaildb.com/api/json/v1/1/search.php?s=" .. enc(q))
	if not d or not d.drinks then return fail("No drinks found") end
	local items = {}
	for i, m in ipairs(d.drinks) do
		if i > 10 then break end
		local ing = {}
		for k = 1, 8 do
			local v = m["strIngredient" .. k]
			if v and v ~= "" then table.insert(ing, v) end
		end
		table.insert(items, { title = m.strDrink, sub = "Ingredients: " .. table.concat(ing, ", "), meta = cut(m.strInstructions, 200), img = m.strDrinkThumb and (m.strDrinkThumb .. "/preview") or nil })
	end
	return { items = items }
end

H.countries = function(q)
	if q == "" then q = "united" end
	local d = fetchJson("https://restcountries.com/v3.1/name/" .. enc(q) .. "?fields=name,capital,population,region,flags")
	if type(d) ~= "table" or not d[1] then return fail("Country not found") end
	local items = {}
	for i, c in ipairs(d) do
		if i > 12 then break end
		table.insert(items, {
			title = c.name.common, sub = (c.capital and c.capital[1] or "No capital") .. "  -  " .. tostring(c.region),
			meta = "Population " .. fmtNum(c.population), img = c.flags and c.flags.png,
		})
	end
	return { items = items }
end

H.space = function()
	local d = fetchJson("https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=10&mode=list")
	if not d or not d.results then return fail("Launch data unavailable (rate limited, try later)") end
	local items = {}
	for _, l in ipairs(d.results) do
		table.insert(items, { title = cut(l.name, 100), sub = tostring(l.net or ""):gsub("T", "  "):gsub("Z", " UTC"), meta = l.status and l.status.name or "" })
	end
	return { items = items }
end

H.art = function(q)
	if q == "" then q = "monet" end
	local d = fetchJson("https://api.artic.edu/api/v1/artworks/search?limit=12&fields=id,title,artist_display,image_id&q=" .. enc(q))
	if not d or not d.data then return fail("Art Institute unavailable") end
	local items = {}
	for _, a in ipairs(d.data) do
		if a.image_id then
			table.insert(items, { title = cut(a.title, 100), sub = cut(a.artist_display, 120), img = "https://www.artic.edu/iiif/2/" .. a.image_id .. "/full/200,/0/default.jpg" })
		end
	end
	if #items == 0 then return fail("No artworks found") end
	return { items = items }
end

H.anime = function(q)
	local url = (q == "") and "https://api.jikan.moe/v4/top/anime?limit=15&sfw=true"
		or ("https://api.jikan.moe/v4/anime?limit=15&sfw=true&q=" .. enc(q))
	local d = fetchJson(url)
	if not d or not d.data then return fail("Anime data unavailable") end
	local items = {}
	for _, a in ipairs(d.data) do
		table.insert(items, {
			title = cut(a.title, 90), sub = "Score " .. tostring(a.score or "?") .. "  -  " .. tostring(a.year or ""),
			meta = cut(a.synopsis, 160), img = a.images and a.images.jpg and a.images.jpg.image_url,
		})
	end
	if #items == 0 then return fail("Nothing found") end
	return { items = items }
end

H.github = function(q)
	local sq = (q == "") and "stars:>50000" or q
	local d = fetchJson("https://api.github.com/search/repositories?sort=stars&per_page=15&q=" .. enc(sq))
	if not d or not d.items then return fail("GitHub unavailable (rate limited, try later)") end
	local items = {}
	for _, r in ipairs(d.items) do
		table.insert(items, { title = r.full_name, sub = cut(r.description, 160), meta = "Stars " .. fmtNum(r.stargazers_count) .. "  -  " .. tostring(r.language or "n/a") })
	end
	return { items = items }
end

H.dog = function()
	local d = fetchJson("https://dog.ceo/api/breeds/image/random/4", true)
	if not d or not d.message then return fail("Dogs unavailable") end
	local items = {}
	for _, u in ipairs(d.message) do
		local breed = tostring(u:match("breeds/([^/]+)/") or "dog"):gsub("%-", " ")
		table.insert(items, { title = breed, img = u, big = true })
	end
	return { items = items }
end

H.cat = function()
	local d = fetchJson("https://api.thecatapi.com/v1/images/search?limit=4", true)
	if type(d) ~= "table" or not d[1] then return fail("Cats unavailable") end
	local items = {}
	for _, c in ipairs(d) do table.insert(items, { img = c.url, big = true }) end
	return { items = items }
end

H.jokes = function()
	local d = fetchJson("https://official-joke-api.appspot.com/jokes/ten", true)
	if type(d) ~= "table" or not d[1] then return fail("Jokes unavailable") end
	local items = {}
	for _, j in ipairs(d) do table.insert(items, { title = j.setup, sub = j.punchline }) end
	return { items = items }
end

H.quotes = function()
	local d = fetchJson("https://dummyjson.com/quotes?limit=6&skip=" .. math.random(0, 1400), true)
	if not d or not d.quotes then return fail("Quotes unavailable") end
	local items = {}
	for _, x in ipairs(d.quotes) do table.insert(items, { title = x.quote, sub = "- " .. tostring(x.author) }) end
	return { items = items }
end

H.trivia = function()
	local d = fetchJson("https://the-trivia-api.com/v2/questions?limit=1", true)
	local q = type(d) == "table" and d[1]
	if not q then return fail("Trivia unavailable") end
	return { question = q.question.text, correct = q.correctAnswer, wrong = q.incorrectAnswers, category = tostring(q.category or ""):gsub("_", " ") }
end

local AIM = { gpt = "openai", mistral = "mistral", llama = "llama", gemini = "gemini" }
H.ai = function(q, m)
	if q == "" then return fail("Type something first") end
	local system = "You are a helpful assistant inside a Roblox phone game. Keep replies short unless the user asks for code. Refuse sexual or adult content."
	local url = "https://text.pollinations.ai/" .. enc(q:sub(1, 600)) .. "?model=" .. (AIM[m] or "openai") .. "&system=" .. enc(system)
	local body = fetchRaw(url, true)
	if not body or body == "" then return fail("AI did not reply") end
	body = body:sub(1, 3500)
	if isBad(body) then body = "That reply was hidden by the safety filter." end
	return { reply = body }
end

-- apps whose results should be re-checked by the filter
local CHECK_OUTPUT = { yt = true, shorts = true, google = true, wiki = true, news = true, books = true, music = true, movies = true, podcasts = true, anime = true, github = true, art = true, recipes = true, cocktails = true }

-- ================= Mn (feeds + AI) =================
local rf = RS:WaitForChild("Mn")
local last = {}
rf.OnServerInvoke = function(plr, app, q, m)
	if typeof(app) ~= "string" or not H[app] then return nil end
	q = tostring(q or ""):sub(1, 200)
	if typeof(m) ~= "string" then m = nil end
	local now = os.clock()
	if lockUntil[plr] and now < lockUntil[plr] then return blockedReply() end
	if isBad(q) then
		registerStrike(plr)
		return blockedReply()
	end
	if last[plr] and now - last[plr] < 0.4 then return { error = "Slow down" } end
	last[plr] = now
	local ok, res = pcall(H[app], q, m)
	if not ok or type(res) ~= "table" then return { error = "Something went wrong" } end
	if res.items and CHECK_OUTPUT[app] then
		local kept = {}
		for _, it in ipairs(res.items) do
			if not (isBad(it.title) or isBad(it.sub)) then table.insert(kept, it) end
		end
		res.items = kept
		if #kept == 0 then return { error = "No results" } end
	end
	return res
end

-- ================= Mn2 (images + save/load) =================
local rf2 = RS:FindFirstChild("Mn2") or RS:FindFirstChild("MnVideo")
if not rf2 then
	rf2 = Instance.new("RemoteFunction")
	rf2.Name = "Mn2"
	rf2.Parent = RS
	warn("PhoneServer: Mn2 was missing, created it. Also add it in Explorer if the client can't find it.")
end

local function toBuffer(b64)
	if type(b64) ~= "string" or b64 == "" then return nil end
	local ok, raw = pcall(HttpService.Base64Decode, HttpService, b64)
	if not ok then return nil end
	return buffer.fromstring(raw)
end

local inflight, lastSave, loaded = {}, {}, {}

local function cleanSave(a1, a2)
	local ids, stats = {}, {}
	local src = a1
	if type(a1) == "table" and type(a1.ids) == "table" then
		src = a1.ids
		if type(a1.stats) == "table" then a2 = a1.stats end
	end
	if type(src) == "table" then
		for _, id in ipairs(src) do
			if typeof(id) == "string" and #id <= 20 and #ids < 60 then table.insert(ids, id) end
		end
	end
	if type(a2) == "table" then
		local n = 0
		for k, v in pairs(a2) do
			if typeof(k) == "string" and #k <= 20 and typeof(v) == "number" and v == v and n < 30 then
				stats[k] = math.clamp(v, -1e9, 1e9)
				n += 1
			end
		end
	end
	return { ids = ids, stats = stats }
end

rf2.OnServerInvoke = function(plr, action, a1, a2, a3)
	if action == "img" then
		local url, w, h = a1, tonumber(a2) or 128, tonumber(a3) or 128
		if typeof(url) ~= "string" or not url:match("^https://") or #url > 500 then return nil end
		if (inflight[plr] or 0) >= 6 then return { error = "busy" } end
		inflight[plr] = (inflight[plr] or 0) + 1
		w = math.clamp(math.floor(w), 32, 256)
		h = math.clamp(math.floor(h), 32, 256)
		local ok, body = pcall(HttpService.GetAsync, HttpService,
			string.format("%s/img?url=%s&w=%d&h=%d&k=%s", VPROXY, enc(url), w, h, enc(KEY)))
		inflight[plr] = math.max(0, (inflight[plr] or 1) - 1)
		if not ok then return { error = "network" } end
		local ok2, data = pcall(HttpService.JSONDecode, HttpService, body)
		if not ok2 or type(data) ~= "table" or data.error then return { error = "image" } end
		return { w = data.w, h = data.h, data = toBuffer(data.data) }

	elseif action == "load" then
		if loaded[plr] then return loaded[plr] end
		local ok, body = pcall(HttpService.GetAsync, HttpService, PROXY .. "?app=load&uid=" .. plr.UserId .. "&k=" .. enc(KEY))
		local result = { ids = {}, stats = {} }
		if ok then
			local ok2, d = pcall(HttpService.JSONDecode, HttpService, body)
			if ok2 and type(d) == "table" and type(d.data) == "table" then result = cleanSave(d.data) end
		end
		loaded[plr] = result
		return result

	elseif action == "save" then
		local now = os.clock()
		if lastSave[plr] and now - lastSave[plr] < 3 then return { ok = false } end
		lastSave[plr] = now
		local data = cleanSave(a1, a2)
		loaded[plr] = data
		local ok = pcall(HttpService.PostAsync, HttpService,
			PROXY .. "?app=save&uid=" .. plr.UserId .. "&k=" .. enc(KEY), HttpService:JSONEncode(data), Enum.HttpContentType.ApplicationJson)
		return { ok = ok }
	end
	return nil
end

-- keep Render awake
task.spawn(function()
	while true do
		pcall(HttpService.GetAsync, HttpService, VPROXY .. "/health")
		task.wait(240)
	end
end)

Players.PlayerRemoving:Connect(function(p)
	last[p] = nil; inflight[p] = nil; lastSave[p] = nil; loaded[p] = nil; strikes[p] = nil; lockUntil[p] = nil
end)
