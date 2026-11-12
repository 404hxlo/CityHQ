-- qb-control (game side): things CityHQ asks the server to show or do on a player's own game.
-- These events are only sent by this resource's server part. A player can only ever trigger
-- them on their own game, where they could do the same things anyway.

local RES = GetCurrentResourceName()

-- ---------------------------------------------------------------- messages on screen
-- Drawn by html/index.html: a big announcement at the top, small messages on the right.
local ICONS = { megaphone = true, car = true, tool = true, fuel = true, shield = true, message = true, clock = true, warning = true }

local function words(value, max)
    return type(value) == 'string' and value:sub(1, max) or nil
end

local function iconName(value, fallback)
    return ICONS[value] and value or fallback
end

-- A big announcement: tag (who it's from), title, an optional line under it, and a countdown.
RegisterNetEvent(RES .. ':client:banner', function(data)
    if type(data) ~= 'table' then return end
    local title = words(data.title, 240)
    if not title or title == '' then return end
    PlaySoundFrontend(-1, 'CHECKPOINT_PERFECT', 'HUD_MINI_GAME_SOUNDSET', true)
    SendNUIMessage({
        action = 'banner',
        tag = words(data.tag, 60) or 'Announcement',
        title = title,
        sub = words(data.sub, 120),
        seconds = math.max(3, math.min(tonumber(data.seconds) or 8, 900)),
        countdown = data.countdown == true,
        icon = iconName(data.icon, 'megaphone'),
    })
end)

-- A small message on the right of the screen.
local function toast(text, tag, icon, seconds)
    if type(text) ~= 'string' or text == '' then return end
    SendNUIMessage({
        action = 'toast',
        tag = words(tag, 40) or 'Server',
        text = text:sub(1, 200),
        seconds = math.max(2, math.min(tonumber(seconds) or 6, 30)),
        icon = iconName(icon, 'message'),
    })
end

RegisterNetEvent(RES .. ':client:toast', function(data)
    if type(data) ~= 'table' then return end
    toast(data.text, data.tag, data.icon, data.seconds)
end)

-- ---------------------------------------------------------------- player tools
RegisterNetEvent(RES .. ':client:armor', function()
    SetPedArmour(PlayerPedId(), 100)
end)

RegisterNetEvent(RES .. ':client:heal', function()
    local ped = PlayerPedId()
    SetEntityHealth(ped, GetEntityMaxHealth(ped))
    ClearPedBloodDamage(ped)
end)

local frozen = false
RegisterNetEvent(RES .. ':client:freeze', function(state)
    frozen = state == true
    local ped = PlayerPedId()
    local vehicle = GetVehiclePedIsIn(ped, false)
    FreezeEntityPosition(vehicle ~= 0 and vehicle or ped, frozen)
    if frozen then
        CreateThread(function()
            while frozen do
                DisableAllControlActions(0)
                EnableControlAction(0, 1, true)   -- look around
                EnableControlAction(0, 2, true)
                EnableControlAction(0, 245, true) -- chat
                EnableControlAction(0, 249, true) -- push to talk
                Wait(0)
            end
        end)
    end
end)

-- ---------------------------------------------------------------- vehicles
local function currentVehicle()
    local ped = PlayerPedId()
    local vehicle = GetVehiclePedIsIn(ped, false)
    if vehicle == 0 then vehicle = GetVehiclePedIsIn(ped, true) end
    return vehicle ~= 0 and DoesEntityExist(vehicle) and vehicle or nil
end

-- Qbox has no teleport event of its own for other scripts, so CityHQ moves the player itself.
RegisterNetEvent(RES .. ':client:teleport', function(x, y, z, heading)
    x, y, z = tonumber(x), tonumber(y), tonumber(z)
    if not x or not y or not z then return end
    local ped = PlayerPedId()
    DoScreenFadeOut(300)
    while not IsScreenFadedOut() do Wait(10) end
    SetPedCoordsKeepVehicle(ped, x, y, z)
    if tonumber(heading) then SetEntityHeading(ped, tonumber(heading)) end
    Wait(300)
    DoScreenFadeIn(300)
end)

RegisterNetEvent(RES .. ':client:fixVehicle', function()
    local vehicle = currentVehicle()
    if not vehicle then return toast('Get in or next to your car to have it repaired', 'Admin', 'car') end
    SetVehicleFixed(vehicle)
    SetVehicleDeformationFixed(vehicle)
    SetVehicleEngineHealth(vehicle, 1000.0)
    SetVehicleBodyHealth(vehicle, 1000.0)
    SetVehiclePetrolTankHealth(vehicle, 1000.0)
    SetVehicleDirtLevel(vehicle, 0.0)
    SetVehicleUndriveable(vehicle, false)
    toast('Your car was repaired', 'Admin', 'tool')
end)

-- Different fuel scripts keep the level in different places, so set every common one.
local FUEL_EXPORTS = { 'qb-fuel', 'LegacyFuel', 'ps-fuel', 'cdn-fuel', 'lj-fuel' }
RegisterNetEvent(RES .. ':client:refuel', function()
    local vehicle = currentVehicle()
    if not vehicle then return toast('Get in or next to your car to have it filled up', 'Admin', 'car') end
    SetVehicleFuelLevel(vehicle, 100.0)
    for _, name in ipairs(FUEL_EXPORTS) do
        if GetResourceState(name) == 'started' then
            pcall(function() exports[name]:SetFuel(vehicle, 100.0) end)
        end
    end
    if DecorIsRegisteredAsType('_FUEL_LEVEL', 1) then DecorSetFloat(vehicle, '_FUEL_LEVEL', 100.0) end
    pcall(function() Entity(vehicle).state:set('fuel', 100.0, true) end)
    toast('Your tank was filled up', 'Admin', 'fuel')
end)
