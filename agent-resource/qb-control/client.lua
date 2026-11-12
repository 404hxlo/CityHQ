-- qb-control (game side): things CityHQ asks the server to show or do on a player's own game.
-- These events are only sent by this resource's server part. A player can only ever trigger
-- them on their own game, where they could do the same things anyway.

local RES = GetCurrentResourceName()

-- ---------------------------------------------------------------- big announcements
local banner = nil

local function loadScaleform(name)
    local handle = RequestScaleformMovie(name)
    local waited = 0
    while not HasScaleformMovieLoaded(handle) and waited < 3000 do
        Wait(10)
        waited = waited + 10
    end
    return HasScaleformMovieLoaded(handle) and handle or nil
end

local function showBanner(title, message, seconds, countdown)
    local scaleform = loadScaleform('MP_BIG_MESSAGE_FREEMODE')
    if not scaleform then return end
    local token = {}
    banner = token
    local endsAt = GetGameTimer() + seconds * 1000
    local lastShown = -1
    PlaySoundFrontend(-1, 'CHECKPOINT_PERFECT', 'HUD_MINI_GAME_SOUNDSET', true)
    CreateThread(function()
        while banner == token and GetGameTimer() < endsAt do
            local left = math.ceil((endsAt - GetGameTimer()) / 1000)
            if left ~= lastShown then
                lastShown = left
                local body = message
                if countdown then
                    body = ('%s~n~~HUD_COLOUR_PURPLELIGHT~%d:%02d'):format(message, left // 60, left % 60)
                end
                BeginScaleformMovieMethod(scaleform, 'SHOW_SHARD_CENTERED_MP_MESSAGE')
                ScaleformMovieMethodAddParamTextureNameString(title)
                ScaleformMovieMethodAddParamTextureNameString(body)
                ScaleformMovieMethodAddParamInt(0)
                ScaleformMovieMethodAddParamInt(21)
                EndScaleformMovieMethod()
            end
            DrawScaleformMovieFullscreen(scaleform, 255, 255, 255, 255, 0)
            Wait(0)
        end
        SetScaleformMovieAsNoLongerNeeded(scaleform)
        if banner == token then banner = nil end
    end)
end

RegisterNetEvent(RES .. ':client:banner', function(title, message, seconds, countdown)
    if type(title) ~= 'string' or type(message) ~= 'string' then return end
    seconds = math.max(3, math.min(tonumber(seconds) or 8, 900))
    showBanner(title:sub(1, 80), message:sub(1, 240), seconds, countdown == true)
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

-- Qbox shows notifications through ox_lib; QBCore through its own event.
local function notify(message, kind)
    if GetResourceState('qbx_core') == 'started' then
        TriggerEvent('ox_lib:notify', { description = message, type = kind or 'inform', duration = 5000 })
    else
        TriggerEvent('QBCore:Notify', message, kind or 'primary', 5000)
    end
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
    if not vehicle then return notify('You need to be in or next to your car', 'error') end
    SetVehicleFixed(vehicle)
    SetVehicleDeformationFixed(vehicle)
    SetVehicleEngineHealth(vehicle, 1000.0)
    SetVehicleBodyHealth(vehicle, 1000.0)
    SetVehiclePetrolTankHealth(vehicle, 1000.0)
    SetVehicleDirtLevel(vehicle, 0.0)
    SetVehicleUndriveable(vehicle, false)
    notify('Your car was repaired by an admin', 'success')
end)

-- Different fuel scripts keep the level in different places, so set every common one.
local FUEL_EXPORTS = { 'qb-fuel', 'LegacyFuel', 'ps-fuel', 'cdn-fuel', 'lj-fuel' }
RegisterNetEvent(RES .. ':client:refuel', function()
    local vehicle = currentVehicle()
    if not vehicle then return notify('You need to be in or next to your car', 'error') end
    SetVehicleFuelLevel(vehicle, 100.0)
    for _, name in ipairs(FUEL_EXPORTS) do
        if GetResourceState(name) == 'started' then
            pcall(function() exports[name]:SetFuel(vehicle, 100.0) end)
        end
    end
    if DecorIsRegisteredAsType('_FUEL_LEVEL', 1) then DecorSetFloat(vehicle, '_FUEL_LEVEL', 100.0) end
    pcall(function() Entity(vehicle).state:set('fuel', 100.0, true) end)
    notify('Your tank was filled by an admin', 'success')
end)
