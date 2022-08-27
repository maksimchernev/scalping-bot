'use srtict'
process.env.NTBA_FIX_319 = 1;
process.env.NTBA_FIX_350 = 1;
const tulind = require('tulind');
let path = require('path');
const ccxt = require ('ccxt');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const fs = require('fs')
const TelegramBot = require('node-telegram-bot-api');
const { macd } = require('technicalindicators');
const { Console } = require('console');
const token = process.env.TG_KEY;
const bot = new TelegramBot(token, {polling: true});

let allowedIds = [422689325, -797023226, 384569274]

let startMsg
const candleTypeRange = 5
const ticker = 'BTC/BUSD'
let availableBalanceBUSD = 2300
let availableBalanceBTC = 0.1

const binanceClient = new ccxt.binance({
    apiKey: process.env.API_KEY,
    secret: process.env.API_SECRET,
});

const inputIndicators = {
    open: [],
    high: [],
    low: [],
    close: [],
    candleType: [],
    psar: [],
    ema: [],
    macd: [],
    macdSignal: []
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const sync = async () => {
	let serverTime = await binanceClient.fetchTime();
    let timeTillTheEndOfTheMinute = 10000 - (serverTime % 10000);
    await wait(timeTillTheEndOfTheMinute+8000); // delay to get most accurate data in a minute frame
}

const initializeInputIndicators = async() => {
    let time = new Date().toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")
    console.log('\n', `Updating at ${time}`);
    let candles = await binanceClient.fetchOHLCV(ticker,candleTypeRange+'m')
    inputIndicators.open = candles.map(arr => arr[1])
    inputIndicators.high = candles.map(arr => arr[2])
    inputIndicators.low = candles.map(arr => arr[3])
    inputIndicators.close = candles.map(arr => arr[4])
    inputIndicators.candleType = candles.map( (arr) => {
        if (arr[1] > arr[4]) {
            return 'red'
        } else {
            return 'green'
        }
    })
} 

const calculatePSAR = async() => {
    tulind.indicators.psar.indicator([inputIndicators.high, inputIndicators.low],[0.025,0.2],(err,res) => {
        if(err) return console.log(err);
        inputIndicators.psar = res[0];
    })
}
const calculateEMA = async() => {
    tulind.indicators.ema.indicator([inputIndicators.close],[200],(err,res) => {
        if(err) return console.log(err);
        inputIndicators.ema = res[0];
    })
}
const calculateMACD = async() => {
    tulind.indicators.macd.indicator([inputIndicators.close],[4,31,7],(err,res) => {
        if(err) return log(err);
        inputIndicators.macd = res[0];
        inputIndicators.macdSignal = res[1];
      });
}

const calculateEnterQuantity = async (currentPrice, buyArray, Time, direction) => {
    console.log('CALCULATING ENTER QUANTITY');
    let enterQuantity
    let recentBuyArray = []
    if(buyArray.length != 0) {
        for (let arr of buyArray) {
            if (Time - arr[1] < 3*60*60*1000) {
                recentBuyArray.push(arr)
            }
        }
    }
    if (direction == 'long') {
        currentPrice = 0.9999*currentPrice;
        if (recentBuyArray.length == 0){
            enterQuantity = availableBalanceBUSD
        } else {
            enterQuantity = 0
        }
        if (enterQuantity < 15) {
            enterQuantity = 0
        }
        enterQuantity = Math.floor(enterQuantity)
        console.log('EnterQuantity long: ', enterQuantity);
    } else if (direction == 'short') {
        currentPrice = 1.00001 * currentPrice;
        console.log(`${ticker} Price: `, currentPrice);

        if (recentBuyArray.length == 0){
            enterQuantity = availableBalanceBTC
        } else {
            enterQuantity = 0
        }
        if (enterQuantity < 15/currentPrice) {
            enterQuantity = 0
        }
        enterQuantity = Math.floor(enterQuantity*100000)/100000
        console.log('EnterQuantity short: ', enterQuantity);
    }
    return enterQuantity;
}
let buyLongOrderInfo = null
let buyShortOrderInfo = null
let sellLongOrderInfo = null
let sellShortOrderInfo = null
let ORDER_UPDATE_PERIOD = 2000

const makeBuyOrder = async (buyQuantity, currentPrice, direction) => {
    if (direction == 'long') {
        console.log('MAKING BUY LONG ORDER');
        buyLongOrderInfo = await binanceClient.createOrder(ticker, 'limit', 'buy', buyQuantity, currentPrice)
        console.log('buyLongOrderInfo: ', buyLongOrderInfo);
    } else if (direction == 'short') {
        console.log('MAKING BUY SHORT ORDER');
        buyShortOrderInfo = await binanceClient.createOrder(ticker, 'limit', 'sell', buyQuantity, currentPrice)
        console.log('buyShortOrderInfo: ', buyShortOrderInfo);
    } else {
        console.log('unknown direction')
    }
	
}

const waitBuyOrderCompletion = async (direction) => {
    let buyQuantity
    let buyPrice
    let buyTime
    let msg
    let busdAmount
    if (direction == 'long') {
        console.log('WAITING BUY LONG ORDER COMPLETION');
        for(let i = 0; i < 7; i++){
            console.log('long order status', buyLongOrderInfo.status)
            if(buyLongOrderInfo.info.status === 'FILLED'){
                console.log('LONG ORDER PURCHASE COMPLETE! \n');
                buyQuantity = buyLongOrderInfo.amount
                buyPrice = buyLongOrderInfo.average
                busdAmount = buyLongOrderInfo.cost
                buyTime = new Date()
                msg = 'success'
                return {msg, buyQuantity, buyPrice, buyTime, busdAmount};
            } 
            console.log('long order waiting...')
            await wait(ORDER_UPDATE_PERIOD);
        }

        console.log('long order status', buyLongOrderInfo.info.status)
        console.log('LONG ORDER PURCHASE TIMED OUT, CANCELLING \n');
        try {
            await binanceClient.cancelOrder(buyLongOrderInfo.id, ticker)
        } catch(e) {
            console.log('ERROR CANCELLING')
        }


        buyLongOrderInfo = await binanceClient.fetchOrder(buyLongOrderInfo.id, ticker)
        let amount = buyLongOrderInfo.info.executedQty
        let initialAmount = buyLongOrderInfo.info.origQty
        if(amount == initialAmount ){
            console.log('LONG ORDER PURCHASE COMPLETE AT DOUBLE CHECK! \n');
            buyQuantity = buyLongOrderInfo.amount
            buyPrice = buyLongOrderInfo.average
            busdAmount = buyLongOrderInfo.cost
            buyTime = new Date()
            msg = 'success'
        } else if (buyLongOrderInfo.cost > 15 && amount < initialAmount) {
            console.log(`LONG ORDER PARTIALLY FILLED! ${buyLongOrderInfo.amount}\n`);
            buyQuantity = buyLongOrderInfo.amount
            buyPrice = buyLongOrderInfo.average
            busdAmount = buyLongOrderInfo.cost
            buyTime = new Date()
            msg = 'success'
            bot.sendMessage(startMsg.chat.id, `Ok! ENTER LONG ORDER PARTIALLY FILLED! Continuing the script. ${buyQuantity} - higher than 15$\n`)
        } else if (buyLongOrderInfo.cost < 15 && buyLongOrderInfo.cost > 0 && amount < initialAmount) {
            busdAmount = null
            buyQuantity = null
            buyPrice = null
            buyTime = new Date()
            msg = 'failure'
            bot.sendMessage(startMsg.chat.id, `SOS! ENTER LONG ORDER PARTIALLY FILLED!  ${buyLongOrderInfo.amount} - lower than 15$\n`)
        } else {
            busdAmount = null
            buyQuantity = null
            buyPrice = null
            buyTime = new Date()
            msg = 'failure'
        }
        return {msg, buyQuantity, buyPrice, buyTime, busdAmount};

    } else if (direction == 'short') {
        console.log('WAITING BUY SHORT ORDER COMPLETION');
        for(let i = 0; i < 7; i++){
            buyShortOrderInfo = await binanceClient.fetchOrder(buyShortOrderInfo.id, ticker)
            console.log('short order status', buyShortOrderInfo.status)
            if(buyShortOrderInfo.status === 'closed'){
                console.log('SHORT ORDER PURCHASE COMPLETE! \n');
                buyQuantity = buyShortOrderInfo.amount
                buyPrice = buyShortOrderInfo.average
                busdAmount = buyShortOrderInfo.cost
                buyTime = new Date()
                msg = 'success'
                return {msg, buyQuantity, buyPrice, buyTime, busdAmount};
            }
            console.log('short order waiting...')
            await wait(ORDER_UPDATE_PERIOD);
        }
        console.log('short order status', buyShortOrderInfo.status)
        console.log('SHORT ORDER PURCHASE TIMED OUT, CANCELLING \n');

        try {
            await binanceClient.cancelOrder(buyShortOrderInfo.id, ticker)
        } catch(e) {
            console.log('ERROR CANCELLING')
        }

        buyShortOrderInfo = await binanceClient.fetchOrder(buyShortOrderInfo.id, ticker)
        let amount = buyShortOrderInfo.info.executedQty
        let initialAmount = buyShortOrderInfo.info.origQty
        if(amount == initialAmount ){
            console.log('SHORT ORDER PURCHASE COMPLETE AT DOUBLE CHECK! \n');
            buyQuantity = buyShortOrderInfo.amount
            buyPrice = buyShortOrderInfo.average
            busdAmount = buyShortOrderInfo.cost
            buyTime = new Date()
            msg = 'success'
        } else if (buyShortOrderInfo.cost > 15 && amount < initialAmount) {
            console.log(`SHORT ORDER PARTIALLY FILLED! ${buyShortOrderInfo.amount}\n`);
            buyQuantity = buyShortOrderInfo.amount
            buyPrice = buyShortOrderInfo.average
            busdAmount = buyShortOrderInfo.cost
            buyTime = new Date()
            msg = 'success'
            bot.sendMessage(startMsg.chat.id, `Ok! ENTER LONG ORDER PARTIALLY FILLED! Continuing the script. ${buyQuantity} - higher than 15$\n`)
        } else if (buyShortOrderInfo.cost < 15 && buyShortOrderInfo.cost > 0 && amount < initialAmount) {
            busdAmount = null
            buyQuantity = null
            buyPrice = null
            buyTime = new Date()
            msg = 'failure'
            bot.sendMessage(startMsg.chat.id, `SOS! ENTER LONG ORDER PARTIALLY FILLED!  ${buyShortOrderInfo.amount} - lower than 15$\n`)
        } else {
            busdAmount = null
            buyQuantity = null
            buyPrice = null
            buyTime = new Date()
            msg = 'failure'
        }         
        return {msg, buyQuantity, buyPrice, buyTime, busdAmount};
    } else {
        console.log('unknown direction')
        busdAmount = null
        buyQuantity = null
        buyPrice = null
        buyTime = new Date()
        msg = 'failure'
        return {msg, buyQuantity, buyPrice, buyTime, busdAmount};
    }
}

const buy = async (enterQuantity, currentPrice, direction) => {
	console.log('BUYING');     
	await makeBuyOrder(enterQuantity, currentPrice, direction);
	let {msg, buyQuantity, buyPrice, buyTime, busdAmount} = await waitBuyOrderCompletion(direction);
	return {msg, buyQuantity, buyPrice, buyTime, busdAmount};
}

const makeSellOrder = async (sellQuantity, currentPrice, direction) => {
    if (direction == 'long') {
        console.log('MAKING LONG EXIT ORDER');
        sellLongOrderInfo = await binanceClient.createOrder(ticker, 'limit', 'sell', sellQuantity, currentPrice)
        console.log('sellLongOrderInfo: ', sellLongOrderInfo);
    } else if (direction == 'short') {
        console.log('MAKING SHORT EXIT ORDER');
        sellShortOrderInfo = await binanceClient.createOrder(ticker, 'limit', 'buy', sellQuantity, currentPrice)
        console.log('sellShortOrderInfo: ', sellShortOrderInfo);
    } else {
        console.log('unknown direction')
    }
}

const waitSellOrderCompletion = async (direction) => {
    let msg
    let sellTime
    let sellQuantity
    let sellPrice
    let busdAmount
    if (direction == 'long') {
        console.log('WAITING LONG EXIT ORDER COMPLETION');
        for(let i = 0; i < 7; i++){
            sellLongOrderInfo = await binanceClient.fetchOrder(sellLongOrderInfo.id, ticker)
            console.log('status', sellLongOrderInfo.status)
            if(sellLongOrderInfo.status === 'closed'){
                console.log('LONG EXIT COMPLETE! \n');
                sellQuantity = sellLongOrderInfo.amount
                sellPrice = sellLongOrderInfo.average
                busdAmount = sellLongOrderInfo.cost
                sellTime = new Date()
                msg = 'success'
                return {msg, sellQuantity, sellPrice, sellTime, busdAmount};
            }
            console.log('waiting...')
            await wait(ORDER_UPDATE_PERIOD);
        }
        console.log('status', sellLongOrderInfo.status)
        console.log('LONG EXIT TIMED OUT, CANCELLING \n');

        try {
            await binanceClient.cancelOrder(sellLongOrderInfo.id, ticker)
        } catch(e) {
            console.log('ERROR CANCELLING')
        }

        sellLongOrderInfo = await binanceClient.fetchOrder(sellLongOrderInfo.id, ticker)
        let amount = sellLongOrderInfo.info.executedQty
        let initialAmount = sellLongOrderInfo.info.origQty
        if(amount == initialAmount ){
            console.log('LONG ORDER EXIT COMPLETE AT DOUBLE CHECK! \n');
            sellQuantity = sellLongOrderInfo.amount
            sellPrice = sellLongOrderInfo.average
            busdAmount = sellLongOrderInfo.cost
            sellTime = new Date()
            msg = 'success'
        } else if (sellLongOrderInfo.cost > 0 && amount < initialAmount) {
            console.log(`LONG EXIT ORDER PARTIALLY FILLED! ${sellLongOrderInfo.amount}\n`);
            sellQuantity = sellLongOrderInfo.amount
            sellPrice = sellLongOrderInfo.average
            busdAmount = sellLongOrderInfo.cost
            sellTime = new Date()
            msg = 'partiallyfilled'
            bot.sendMessage(startMsg.chat.id, `Ok! LONG EXIT ORDER PARTIALLY FILLED! Continuing the script. ${sellQuantity} - higher than 15$\n`)
        } else {
            busdAmount = null
            sellQuantity = null
            sellPrice = null
            sellTime = new Date()
            msg = 'failure'
        }        
        return {msg, sellQuantity, sellPrice, sellTime, busdAmount};

    } else if (direction == 'short') {
        console.log('WAITING SHORT EXIT ORDER COMPLETION');
        for(let i = 0; i < 7; i++){
            sellShortOrderInfo = await binanceClient.fetchOrder(sellShortOrderInfo.id, ticker)
            console.log('status', sellShortOrderInfo.status)
            if(sellShortOrderInfo.status === 'closed'){
                console.log('SHORT EXIT COMPLETE! \n');
                busdAmount = sellShortOrderInfo.cost
                sellQuantity = sellShortOrderInfo.amount
                sellPrice = sellShortOrderInfo.average
                sellTime = new Date()
                msg = 'success'
                return {msg, sellQuantity, sellPrice, sellTime, busdAmount};
            }
            console.log('waiting...')
            await wait(ORDER_UPDATE_PERIOD);
        }
        console.log('status', sellShortOrderInfo.status)
        console.log('SHORT EXIT TIMED OUT, CANCELLING \n');

        try {
            await binanceClient.cancelOrder(sellShortOrderInfo.id, ticker)
        } catch(e) {
            console.log('ERROR CANCELLING')
        }


        sellShortOrderInfo = await binanceClient.fetchOrder(sellShortOrderInfo.id, ticker)

        let amount = sellShortOrderInfo.info.executedQty
        let initialAmount = sellShortOrderInfo.info.origQty
        if(amount == initialAmount ){
            console.log('SHORT ORDER EXIT COMPLETE AT DOUBLE CHECK! \n');
            sellQuantity = sellShortOrderInfo.amount
            sellPrice = sellShortOrderInfo.average
            busdAmount = sellShortOrderInfo.cost
            sellTime = new Date()
            msg = 'success'
        } else if (sellShortOrderInfo.cost > 0 && amount < initialAmount) {
            console.log(`SHORT EXIT ORDER PARTIALLY FILLED! ${sellShortOrderInfo.amount}\n`);
            sellQuantity = sellShortOrderInfo.amount
            sellPrice = sellShortOrderInfo.average
            busdAmount = sellShortOrderInfo.cost
            sellTime = new Date()
            msg = 'partiallyfilled'
            bot.sendMessage(startMsg.chat.id, `Ok! SHORT EXIT ORDER PARTIALLY FILLED! Continuing the script. ${sellQuantity} - higher than 15$\n`)
        } else {
            busdAmount = null
            sellQuantity = null
            sellPrice = null
            sellTime = new Date()
            msg = 'failure'
        }        
        return {msg, sellQuantity, sellPrice, sellTime, busdAmount};
    } else {
        console.log('unknown direction')
        busdAmount = null
        sellQuantity = null
        sellPrice = null
        sellTime = new Date()
        msg = 'failure'
        return {msg, sellQuantity, sellPrice, sellTime, busdAmount};
    }
}

const sell = async (exitQuantity, currentPrice, direction) => {
    console.log('SELLING!');     
    await makeSellOrder(exitQuantity, currentPrice, direction);
    let {msg, sellQuantity, sellPrice, sellTime, busdAmount} = await waitSellOrderCompletion(direction);
    return {msg, sellQuantity, sellPrice, sellTime, busdAmount};
}

let run
let statistics = []
let buyArrayLong = []
let buyArrayShort = []
let profits = []
let startTime
let accumulatedProfit = 0
let accumulatedProfitBUSD = 0

const enterLong = async (currentPrice, buyArrayLong, Time, buyIndex) => {
    let errorDidNotWork
    let errorEnteredTooManyTimes
    let errorInCalculatingEnterQuantity
    console.log(`Buying long... At ${Time}`)                     
    let enterQuantity = await calculateEnterQuantity(currentPrice, buyArrayLong, Time, 'long')//in BUSD
    //case error in calculate enter quantity
    if (enterQuantity != undefined && currentPrice != undefined) {
        errorInCalculatingEnterQuantity = false
        enterQuantity = enterQuantity/currentPrice // in BTC
        enterQuantity = Math.floor(enterQuantity * 100000) / 100000; // to 5 numbers after 0
        if (enterQuantity != 0){
/*             let msg = 'success'
            let buyQuantity = enterQuantity
            let buyPrice = currentPrice
            let buyTime = Time
            let busdAmount = 1300 */
            errorEnteredTooManyTimes = false 
            let {msg, buyQuantity, buyPrice, buyTime, busdAmount} = await buy(enterQuantity, currentPrice, 'long')
            if (msg === 'success') {
                errorDidNotWork = false
                availableBalanceBUSD = availableBalanceBUSD - busdAmount
                console.log(' ')
                let stoploss
                if (buyPrice - inputIndicators.psar[inputIndicators.psar.length-1] > 200) { 
                    stoploss = buyPrice - ((buyPrice - inputIndicators.psar[inputIndicators.psar.length-1]) *0.2)
                } else if (buyPrice - inputIndicators.psar[inputIndicators.psar.length-1] > 150) {
                    stoploss = buyPrice - ((buyPrice - inputIndicators.psar[inputIndicators.psar.length-1]) *0.3)
                } else if (buyPrice - inputIndicators.psar[inputIndicators.psar.length-1] > 100) {
                    stoploss = buyPrice - ((buyPrice - inputIndicators.psar[inputIndicators.psar.length-1]) *0.5)
                } else if (buyPrice - inputIndicators.psar[inputIndicators.psar.length-1] < 100) {
                    stoploss = buyPrice - 60
                } else {
                    stoploss = inputIndicators.psar[inputIndicators.psar.length-1]
                }

                let takeProfit
                if (buyIndex != undefined) {
                    let difference = inputIndicators.psar[buyIndex-1-1] - inputIndicators.psar[inputIndicators.psar.length - 1]
                    if (difference > 200) {
                        takeProfit = inputIndicators.psar[buyIndex-1-1] + (difference*0.5)
                    } else if (difference > 150) {
                        takeProfit = inputIndicators.psar[buyIndex-1-1] + (difference*0.4)
                    } else if (difference > 100) {
                        takeProfit = inputIndicators.psar[buyIndex-1-1] + (difference*0.6)
                    } else {
                        takeProfit = inputIndicators.psar[buyIndex-1-1] + (difference)
                    }
                    if (takeProfit - buyPrice < 50) {
                        takeProfit = buyPrice + 40
                    }
                } else {
                    takeProfit = buyPrice + 90
                }
                bot.sendMessage(startMsg.chat.id, `enter long ${buyPrice}, ${buyTime.toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")}, amount ${buyQuantity}, stoploss ${stoploss}, takeProfit ${takeProfit}`)
                console.log(`enter long ${buyPrice}, ${buyTime.toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")}, amount ${buyQuantity}, stoploss ${stoploss}, takeProfit ${takeProfit}`)
                buyArrayLong.push([buyPrice, buyTime, buyQuantity, stoploss, takeProfit])
                console.log('buyArrayLong:', buyArrayLong)
            } else if (msg == 'failure') {
                errorDidNotWork = true
                console.log(`long buy order did not work at ${currentPrice} ${buyTime.toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")} amount ${buyQuantity}`)
            }
        } else {
            errorEnteredTooManyTimes = true
            console.log('do not buy long since we entered too many times')
        }
    } else {
        errorInCalculatingEnterQuantity = true
        throw new Error('ERROR IN CALCULATE ENTER QUANTITY LONG')
    }
    return {errorDidNotWork, errorEnteredTooManyTimes, errorInCalculatingEnterQuantity}
}
const enterShort = async (currentPrice, buyArrayShort, Time, buyIndex) => {
    let errorDidNotWork
    let errorEnteredTooManyTimes
    let errorInCalculatingEnterQuantity
    console.log(`Buying short... At ${Time}`)
    let enterQuantity = await calculateEnterQuantity(currentPrice, buyArrayShort, Time, 'short')//in BTC
    if (enterQuantity !=undefined && currentPrice != undefined) {
        errorInCalculatingEnterQuantity = false
        enterQuantity = Math.floor(enterQuantity * 100000) / 100000; // to 5 numbers after 0
        if (enterQuantity != 0) {
            errorEnteredTooManyTimes = false
/*             let msg = 'success'
            let buyQuantity = enterQuantity
            let buyPrice = currentPrice
            let buyTime = Time
            let busdAmount = 1300   */
            let {msg, buyQuantity, buyPrice, buyTime, busdAmount} = await buy(enterQuantity, currentPrice, 'short')
            if (msg == 'success') {
                errorDidNotWork = false
                availableBalanceBTC = availableBalanceBTC - buyQuantity
                console.log(' ')

                let stoploss
                if (inputIndicators.psar[inputIndicators.psar.length-1] - buyPrice > 200) {
                    stoploss = buyPrice + ((inputIndicators.psar[inputIndicators.psar.length-1] - buyPrice) *0.2)
                } else if (inputIndicators.psar[inputIndicators.psar.length-1] - buyPrice > 150) {
                    stoploss = buyPrice + ((inputIndicators.psar[inputIndicators.psar.length-1] - buyPrice) *0.3)
                } else if (inputIndicators.psar[inputIndicators.psar.length-1] - buyPrice > 100) {
                    stoploss = buyPrice + ((inputIndicators.psar[inputIndicators.psar.length-1] - buyPrice) *0.5)
                } else if (inputIndicators.psar[inputIndicators.psar.length-1] - buyPrice < 100) {
                    stoploss = buyPrice + 60
                } else {
                    stoploss = inputIndicators.psar[inputIndicators.psar.length-1]
                }

                let takeProfit
                if (buyIndex != undefined) {
                    let difference = inputIndicators.psar[inputIndicators.psar.length - 1] - inputIndicators.psar[buyIndex-1-1]
                    if (difference > 200) {
                        takeProfit = inputIndicators.psar[buyIndex-1-1] - (difference*0.5)
                    } else if (difference > 150) {
                        takeProfit = inputIndicators.psar[buyIndex-1-1] - (difference*0.4)
                    } else if (difference > 100) {
                        takeProfit = inputIndicators.psar[buyIndex-1-1] - (difference*0.6)
                    } else {
                        takeProfit = inputIndicators.psar[buyIndex-1-1] - (difference)
                    }
                    if (buyPrice - takeProfit < 50) {
                        takeProfit = buyPrice - 40
                    }
                } else {
                    takeProfit = buyPrice - 90
                }
              
                bot.sendMessage(startMsg.chat.id, `enter short ${buyPrice} ${buyTime.toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")}, amount ${buyQuantity}, stop loss ${stoploss}, take profit ${takeProfit}`)
                console.log(`enter short ${buyPrice} ${buyTime.toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")}, amount ${buyQuantity}, stop loss ${stoploss}, take profit ${takeProfit}`)
                buyArrayShort.push([buyPrice, buyTime, buyQuantity, stoploss, takeProfit])
                console.log('buyArrayShort:', buyArrayShort)
            } else if (msg == 'failure') {
                errorDidNotWork = true
                console.log(`short buy order did not work at ${currentPrice} ${buyTime.toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")} amount ${buyQuantity}`)
            }
        } else {
            errorEnteredTooManyTimes = true
            console.log('do not buy short since we entered too many times')
        }
    } else {
        errorInCalculatingEnterQuantity = true
        throw new Error('ERROR IN CALCULATE ENTER QUANTITY SHORT')
    }
    return {errorDidNotWork, errorEnteredTooManyTimes, errorInCalculatingEnterQuantity}
}
const exitLong = async (buyPrice, buyTime, buyQuantity, stoploss, takeProfit, currentPrice, currentTime) => {
/*     let msg = 'success'
    let sellQuantity = buyQuantity
    let sellPrice = currentPrice
    let sellTime = currentTime
    let busdAmount = 1300   */

    let errorDidNotWork
    console.log(`Exiting long at ${currentTime}`)
    let notSold
    let {msg, sellQuantity, sellPrice, sellTime, busdAmount} = await sell(buyQuantity, currentPrice, 'long')

    if (msg == 'success') {
        errorDidNotWork = false
        availableBalanceBUSD = availableBalanceBUSD + busdAmount
        bot.sendMessage(startMsg.chat.id, `exit long ${sellPrice} ${sellTime} amount ${sellQuantity}(buy ${buyPrice} at ${buyTime.toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")} amount ${buyQuantity})`)
        console.log(`exit long ${sellPrice} ${sellTime} amount ${sellQuantity}(buy ${buyPrice} at ${buyTime.toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")} amount ${buyQuantity})`)
        let profit = (sellPrice/buyPrice-1) *100
        let busdProfit = buyPrice*buyQuantity*((sellPrice/buyPrice)-1)
        let type = 'long'
        statistics.push({type, buyPrice, buyTime, buyQuantity, sellPrice, sellTime, sellQuantity, profit, busdProfit})
        profits.push([profit, busdProfit])
    } else if (msg == 'failure') {
        errorDidNotWork = true
        notSold = [buyPrice, buyTime, buyQuantity, stoploss, takeProfit]
        console.log(`Exit long order did not work. Buy price ${buyPrice} at ${buyTime.toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")} sell ${sellPrice} at ${currentTime}`)
    } else if (msg == 'partiallyfilled') {
        errorDidNotWork = false
        let notFilledBuyQuantity = buyQuantity - sellQuantity
        notSold = [buyPrice, buyTime, notFilledBuyQuantity, stoploss, takeProfit]
        bot.sendMessage(startMsg.chat.id, `Ok! EXIT LONG ORDER PARTIALLY FILLED! Continuing the script. Exited with ${sellQuantity}BTC which is ${busdAmount}BUSD\n`)
        console.log(`Ok! EXIT LONG ORDER PARTIALLY FILLED! Continuing the script. Exited with ${sellQuantity}BTC which is ${busdAmount}BUSD\n`)
    }
    return {errorDidNotWork, notSold}
}
const exitShort = async (buyPrice, buyTime, buyQuantity, stoploss, takeProfit, currentPrice, currentTime) => {
/*     let msg = 'success'
    let sellQuantity = buyQuantity
    let sellPrice = currentPrice
    let sellTime = currentTime
    let busdAmount = 1300  */

    let errorDidNotWork
    console.log(`Exiting short at ${currentTime}`)
    let notSold
    let {msg, sellQuantity, sellPrice, sellTime, busdAmount} = await sell(buyQuantity, currentPrice, 'short')

    if (msg == 'success') {
        errorDidNotWork = false
        let profit = (buyPrice/sellPrice-1) *100
        let busdProfit = sellQuantity*sellPrice*((buyPrice/sellPrice)-1)
        availableBalanceBTC = availableBalanceBTC + sellQuantity
        availableBalanceBUSD = availableBalanceBUSD + busdProfit
        bot.sendMessage(startMsg.chat.id, `exit short ${sellPrice} ${sellTime} amount ${sellQuantity}(buy ${buyPrice} at ${buyTime.toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")} amount ${buyQuantity})`)
        console.log(`exit short ${sellPrice} ${sellTime} amount ${sellQuantity}(enter ${buyPrice} at ${buyTime.toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")} amount ${buyQuantity})`)
        let type = 'short'
        statistics.push({type, buyPrice, buyTime, buyQuantity, sellPrice, sellTime, sellQuantity, profit, busdProfit})
        profits.push([profit, busdProfit])
    } else if (msg == 'failure') {
        errorDidNotWork = true
        notSold = [buyPrice, buyTime, buyQuantity, stoploss, takeProfit]
        console.log(`Exit short order did not work. Enter short ${buyPrice} at ${buyTime.toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")} sell ${sellPrice} at ${currentTime}`)
    } else if (msg == 'partiallyfilled') {
        errorDidNotWork = false
        let notFilledBuyQuantity = buyQuantity - sellQuantity
        notSold = [buyPrice, buyTime, notFilledBuyQuantity, stoploss, takeProfit]
        console.log(`Ok! EXIT SHORT ORDER PARTIALLY FILLED! Continuing the script. Exited with ${sellQuantity}BTC which is ${busdAmount}BUSD\n`)
        bot.sendMessage(startMsg.chat.id, `Ok! EXIT SHORT ORDER PARTIALLY FILLED! Continuing the script. Exited with ${sellQuantity}BTC which is ${busdAmount}BUSD\n`)
    }  
    return {errorDidNotWork, notSold}                    
}


const psarConditionLong = (epoches) => {
    // checking last number of epoches on PSAR buy signal
    let buyIndex
    for (let i = inputIndicators.high.length-1; i >= inputIndicators.high.length-1-epoches; i--) {
        //since number of PSARS in array is different, creating corresponding index for psar
        let iPSAR = i-1
        //logic to find PSAR buy signal
        if (inputIndicators.psar[iPSAR] < inputIndicators.low[i] && inputIndicators.psar[iPSAR-1] >= inputIndicators.high[i-1]) {
            //writing index where signal occured
            buyIndex = i
            break
        } 
    }
    return buyIndex
}

const psarConditionShort = (epoches) => {
    //checking last number of epoches on PSAR sell signal
    let buyIndex
    for (let i = inputIndicators.low.length-1; i >= inputIndicators.low.length-1-epoches; i--) {
        //since number of PSARS in array is different, creating corresponding index for psar
        let iPSAR = i-1
        //logic to find PSAR sell signal
            if (inputIndicators.psar[iPSAR] > inputIndicators.high[i] && inputIndicators.psar[iPSAR-1] <= inputIndicators.low[i-1]) {
            //writing index where signal occured
            buyIndex = i
            break
        } 
    }
    return buyIndex
}

const emaConditionLong = (buyIndex) => {
    let emaCondition
    if (inputIndicators.psar[buyIndex-1-1] > inputIndicators.ema[buyIndex-1]) {
        emaCondition = true            
    } else {
        emaCondition = false
    }
    return emaCondition
}

const emaConditionShort = (buyIndex) => {
    let emaCondition
    if (inputIndicators.psar[buyIndex-1-1] < inputIndicators.ema[buyIndex-1]) {
        emaCondition = true
    } else {
        emaCondition = false
    }
    return emaCondition
}

const macdConditionLong = () => {
    let macdCondition
    if (inputIndicators.macd[inputIndicators.macd.length-1] > inputIndicators.macdSignal[inputIndicators.macdSignal.length-1]) {
        macdCondition = true
    } else {
        macdCondition = false
    } 
    return macdCondition
}

const macdConditionShort = () => {
    let macdCondition
    if (inputIndicators.macd[inputIndicators.macd.length-1] < inputIndicators.macdSignal[inputIndicators.macdSignal.length-1]) {
        macdCondition = true
    } else {
        macdCondition = false
    }
    return macdCondition
}

const penetrationConditionLong = async(buyIndex) => {
    let penetrationCondition
    let prices = await binanceClient.fetchTicker(ticker)
    let currentPrice = prices.last
    if (currentPrice > inputIndicators.psar[buyIndex-1-1]) {
        penetrationCondition = true
    } else {
        penetrationCondition = false
    }
    return {currentPrice, penetrationCondition}
}
const penetrationConditionShort = async(buyIndex) => {
    let penetrationCondition
    let prices = await binanceClient.fetchTicker(ticker)
    let currentPrice = prices.last
    if (currentPrice < inputIndicators.psar[buyIndex-1-1]) {
        penetrationCondition = true
    } else {
        penetrationCondition = false
    }
    return {currentPrice, penetrationCondition}
}

 
const divergencyConditionLong = (buyIndex) => {
    let divergencyCondition 
    let lastPsarSellIndex
    for (let i = inputIndicators.high.length-1; i > 0; i-- ) {
        if (inputIndicators.psar[i-1] > inputIndicators.high[i] && inputIndicators.psar[i-1-1] <= inputIndicators.low[i-1]) {
            lastPsarSellIndex = i
            console.log('lastPsarSellIndex', lastPsarSellIndex)
            break
        }
    }

    if ((inputIndicators.open[buyIndex]+inputIndicators.close[buyIndex])/2 - (inputIndicators.open[lastPsarSellIndex]+inputIndicators.close[lastPsarSellIndex])/2 > 20) {
        divergencyCondition  = true
    } else{ 
        divergencyCondition  = false
    }
    console.log(`Divergency: last sellPsar avg  price: ${(inputIndicators.open[lastPsarSellIndex]+inputIndicators.close[lastPsarSellIndex])/2} current buy ${(inputIndicators.open[buyIndex]+inputIndicators.close[buyIndex])/2}`)
    return divergencyCondition
}

const divergencyConditionShort = (buyIndex) => {
    let divergencyCondition 
    let lastPsarBuyIndex
    for (let i = inputIndicators.high.length-1; i > 0; i-- ) {
        if (inputIndicators.psar[i-1] < inputIndicators.low[i] && inputIndicators.psar[i-1-1] >= inputIndicators.high[i-1]) {
            lastPsarBuyIndex = i
            console.log('lastPsarBuyIndex', lastPsarBuyIndex)
            break
        }
    }
    if ((inputIndicators.open[lastPsarBuyIndex]+inputIndicators.close[lastPsarBuyIndex])/2 - (inputIndicators.open[buyIndex]+inputIndicators.close[buyIndex])/2 > 20) {
        divergencyCondition  = true
    } else{ 
        divergencyCondition  = false
    }
    console.log(`Divergency: last buyPsar avg price: ${(inputIndicators.open[lastPsarBuyIndex]+inputIndicators.close[lastPsarBuyIndex])/2} current sell ${(inputIndicators.open[buyIndex]+inputIndicators.close[buyIndex])/2}`)

    return divergencyCondition
}
const adxCondition = (inputIndicators) => {
    let dxCondition
    if (inputIndicators.dx[inputIndicators.dx.length-1] < 63) {
        dxCondition = true
    } else {
        dxCondition = false
    }
    return dxCondition
}

const logConditions = (buyIndex, emaCondition, divergencyCondition, macdCondition, penetrationCondition, direction) => {
    let TestTime = new Date().toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")
    if (direction == 'long') {
        if (buyIndex) {
            console.log(`PSAR long enter signal ${inputIndicators.high.length-1-buyIndex} epoches ago at ${TestTime}. Psar ${inputIndicators.psar[buyIndex-1]}, prev PSAR ${inputIndicators.psar[buyIndex-1-1]}`)
        } else {
            console.log(`No psar long enter signal at ${TestTime}. Psar ${inputIndicators.psar[inputIndicators.psar.length-1]}, prev PSAR ${inputIndicators.psar[inputIndicators.psar.length-1-1]}`)
        }
        if (emaCondition) {
            console.log(`+ Long! Prev psar indicator находится выше! Ema: ${inputIndicators.ema[buyIndex-1]}, prev Psar: ${inputIndicators.psar[buyIndex-1-1]}`)        
        } else {
            console.log(`- prev psar indicator long находится ниже ema. Ema: ${inputIndicators.ema[buyIndex-1]}, prev Psar: ${inputIndicators.psar[buyIndex-1-1]}` )
        }
        if (macdCondition) {
            console.log(`+ Macd is higher than mcd signal! Macd: ${inputIndicators.macd[inputIndicators.macd.length-1]}, Macd signal: ${inputIndicators.macdSignal[inputIndicators.macdSignal.length-1]}`)
        } else {
            console.log(`- macd is lower than macd signal. Macd: ${inputIndicators.macd[inputIndicators.macd.length-1]}, Macd signal: ${inputIndicators.macdSignal[inputIndicators.macdSignal.length-1]}`)
        }
        if (penetrationCondition) {
            console.log('Прострел LONG!')
        } else {
            console.log('Нет прострела LONG')
        }
        if (divergencyCondition) {
            console.log('Divergency!')
        } else {
            console.log('Has not spot the divergency')
        }
    } else if(direction == 'short') {
        if (buyIndex) {
        console.log(`PSAR short enter signal ${inputIndicators.low.length-1-buyIndex} epoches ago at ${TestTime}`)
        } else {
            console.log(`No psar short enter signal at ${TestTime}. Psar ${inputIndicators.psar[inputIndicators.psar.length-1]}, prev PSAR ${inputIndicators.psar[inputIndicators.psar.length-1-1]}`)
        }
        if (emaCondition) {
            console.log(`+ Short! Prev psar indicator находится ниже! Ema: ${inputIndicators.ema[buyIndex-1]}, prev Psar: ${inputIndicators.psar[buyIndex-1-1]}` )
        } else {
            console.log(`- prev psar indicator short находится выше ema. Ema: ${inputIndicators.ema[buyIndex-1]}, prev Psar: ${inputIndicators.psar[buyIndex-1-1]}` )
        }
        if (macdCondition) {
            console.log(`+ Macd is lower than mcd signal! Macd: ${inputIndicators.macd[inputIndicators.macd.length-1]}, Macd signal: ${inputIndicators.macdSignal[inputIndicators.macdSignal.length-1]}`)
        } else {
            console.log(`- macd is higher than mcd signal. Macd: ${inputIndicators.macd[inputIndicators.macd.length-1]}, Macd signal: ${inputIndicators.macdSignal[inputIndicators.macdSignal.length-1]}`)
        }
        if (penetrationCondition) {
            console.log('Прострел SHORT!')
        } else {
            console.log('Нет прострела SHORT')
        }
        if (divergencyCondition) {
            console.log('Divergency!')
        } else {
            console.log('Has not spot the divergency')
        }
    }

}
const main = async() => {
    //wait till 18sec, 38sec or 58sec when started
    try {
		await sync();
    } catch(e) {
        console.error('ERROR DURING SYNC: ', e);
    }
    let epoches = 3
    let beingExecutedEnterLong
    let beingExecutedEnterShort
    while(run){
        //getting OHLC
        let keepTrying;
        do {
            try {
                await initializeInputIndicators();
                keepTrying = false;
            } catch(e) {
                console.error('ERROR IN initializeInputIndicators: ', e) 
                await wait(10000)
                console.log('trying again to initializeInputIndicators')
                keepTrying = true;
            }
        } while (keepTrying)
        //PSAR and EMA
        try {
            await calculatePSAR();
            await calculateEMA();
            await calculateMACD();
        } catch (e) {
            console.error('ERROR IN calculateIndicators: ', e);
        }
        
        //////////////!
        ///           !
        /// ENTERS    !
        ///           !
        //////////////!

        //            !
        // Enter long !
        //            !

        if (!beingExecutedEnterLong) {
            (async function() {
                let currentPrice
                let buyIndex = psarConditionLong(epoches)
                let emaCondition
                let macdCondition
                let divergencyCondition
                let penetrationCondition
                //logic to check on PSAR before signal location relatively to EMA 
                if (buyIndex) {
                    console.log('\n', 'ENTER LONG INFO')
                    let TestTime = new Date().toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")
                    console.log(`PSAR long enter signal ${inputIndicators.high.length-1-buyIndex} epoches ago at ${TestTime}. Psar ${inputIndicators.psar[buyIndex-1]}, prev PSAR ${inputIndicators.psar[buyIndex-1-1]}`)
                    emaCondition = emaConditionLong(buyIndex)
                    macdCondition = macdConditionLong()
                    divergencyCondition = divergencyConditionLong(buyIndex)
                    let keepTrying
                    do {
                        try {
                            ({currentPrice, penetrationCondition} = await penetrationConditionLong(buyIndex));
                            keepTrying = false
                        } catch {
                            console.log('ERROR WHEN CHECKING PENETRATION LONG')
                            await wait(5000)
                            keepTrying = true
                        }
                    } while(keepTrying)
                } else {
                    console.log('\n', 'ENTER LONG INFO')
                    let TestTime = new Date().toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")
                    console.log(`No psar long enter signal at ${TestTime}. Psar ${inputIndicators.psar[inputIndicators.psar.length-1]}, prev PSAR ${inputIndicators.psar[inputIndicators.psar.length-1-1]}`)
                }
                if (buyIndex && (emaCondition || divergencyCondition) && macdCondition && penetrationCondition) {     
                    logConditions(buyIndex, emaCondition, divergencyCondition, macdCondition, penetrationCondition, 'long')      
                    let Time = new Date()
                    let alreadyBought = false
                    if (buyArrayLong.length != 0 ) {
                        for (let arr of buyArrayLong) {
                            if (Time-arr[1] < (epoches+1)*candleTypeRange*60*1000-10000 ) {
                                alreadyBought = true 
                                break
                            } 
                        }
                    }
                    let recentlyExited = false
                    if (statistics.length !=0) {
                        for (let obj of statistics) {
                            if (Time - obj.sellTime < (epoches+1)*candleTypeRange*60*1000-10000 && obj.type == 'long') {
                                recentlyExited = true
                                break
                            }
                        }
                    }
                    if (!alreadyBought && !recentlyExited) {
                        // logic to check on current candle penetration of the previous PSAR
                        beingExecutedEnterLong = true
                        let keepTrying
                        do {
                            try {
                                let timeLeft = await binanceClient.fetchTime();
                                timeLeft = 300000 - (timeLeft%300000)
                                console.log('All conditions are met once, checking a second time')
                                if (timeLeft > 2000) {
                                    await wait(timeLeft-2000)
                                }
                                
                                buyIndex = psarConditionLong(epoches);
                                emaCondition = emaConditionLong(buyIndex);
                                macdCondition = macdConditionLong();
                                ({currentPrice, penetrationCondition} = await penetrationConditionLong(buyIndex));
                                divergencyCondition = divergencyConditionLong(buyIndex)
                                keepTrying = false
                                console.log('divergencyCondition: ', divergencyCondition)

                            } catch {
                                console.log('ERROR WHEN FETCHING TIME')
                                await wait(5000)
                                keepTrying = true
                            }
                        } while (keepTrying)

                        if (buyIndex && (emaCondition || divergencyCondition) && macdCondition && penetrationCondition) {
                            logConditions(buyIndex, emaCondition, divergencyCondition, macdCondition, penetrationCondition, 'long')      
                            console.log('Confirmed conditions long!')
                            // не покупать на хаях
                            if (currentPrice - inputIndicators.psar[buyIndex-1-1] < 70) {
                                console.log(`Не хаи. CurrentPrice: ${currentPrice} diff ${currentPrice - inputIndicators.psar[buyIndex-1-1]}` )
                                console.log(`${ticker} Price: `, currentPrice); 
                                let keepTrying
                                do {
                                    try {
                                        await enterLong(currentPrice, buyArrayLong, Time, buyIndex)
                                        keepTrying = false
                                    } catch(e) {
                                        console.error('ERROR WHEN ENTERING LONG')
                                        await wait(5000)
                                        keepTrying = true
                                    }
                                } while (keepTrying)
                            } else {
                                console.log(`Не покупаем на хаях. CurrentPrice: ${currentPrice} diff ${currentPrice - inputIndicators.psar[buyIndex-1-1]}`)
                            } 
                        } else {
                            console.log('unconfirmed conditions long!')
                            logConditions(buyIndex, emaCondition, divergencyCondition, macdCondition, penetrationCondition, 'long')      
                        }

                        beingExecutedEnterLong = false

                    } else {
                        console.log('already entered long here')
                    }
                }
            })();
        }
        //             !
        // ENTER short !
        //             !
        if (!beingExecutedEnterShort ) {
            (async function() {
                let currentPrice
                let buyIndex = psarConditionShort(epoches)
                let emaCondition
                let macdCondition
                let divergencyCondition
                let penetrationCondition
                //logic to check on PSAR before signal location relatively to EMA 
                if (buyIndex) {
                    console.log('\n', 'ENTER SHORT INFO')
                    let TestTime = new Date().toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")
                    console.log(`PSAR short enter signal ${inputIndicators.low.length-1-buyIndex} epoches ago at ${TestTime}`)
                    emaCondition = emaConditionShort(buyIndex)
                    macdCondition = macdConditionShort()
                    divergencyCondition = divergencyConditionShort(buyIndex)
                    let keepTrying
                    do {
                        try {
                            ({currentPrice, penetrationCondition} = await penetrationConditionShort(buyIndex))
                            keepTrying = false
                        } catch {
                            console.log('ERROR WHEN CHECKING PENETRATION SHORT')
                            await wait(5000)
                            keepTrying = true
                        }
                    } while(keepTrying)
                } else {
                    console.log('\n', 'ENTER SHORT INFO')
                    let TestTime = new Date().toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")
                    console.log(`No psar short enter signal at ${TestTime}. Psar ${inputIndicators.psar[inputIndicators.psar.length-1]}, prev PSAR ${inputIndicators.psar[inputIndicators.psar.length-1-1]}`)
                }
                if (buyIndex && (emaCondition || divergencyCondition) && macdCondition && penetrationCondition) {
                    logConditions(buyIndex, emaCondition, divergencyCondition, macdCondition, penetrationCondition, 'short')      
                    let Time = new Date()
                    let alreadyBought = false
                    if (buyArrayShort.length != 0 ) {
                        for (let arr of buyArrayShort) {
                            if (Time-arr[1] < (epoches+1)*candleTypeRange*60*1000-10000 ) {
                                alreadyBought = true 
                                break
                            } 
                        }
                        
                    }
                    let recentlyExited = false
                    if (statistics.length !=0) {
                        for (let obj of statistics) {
                            if (Time - obj.sellTime < (epoches+1)*candleTypeRange*60*1000-10000 && obj.type == 'short') {
                                recentlyExited = true
                                break
                            }
                        }
                    }
                    if (!alreadyBought && !recentlyExited) {
                        // logic to check on current candle penetration of the previous PSAR
                        beingExecutedEnterShort = true
                        let keepTrying
                        do {
                            try {
                                let timeLeft = await binanceClient.fetchTime();
                                timeLeft = 300000 - (timeLeft%300000)
                                console.log('All conditions are met once, checking a second time')
                                if (timeLeft > 2000) {
                                    await wait(timeLeft-2000)
                                }                                
                                
                                buyIndex = psarConditionShort(epoches);
                                emaCondition = emaConditionShort(buyIndex);
                                macdCondition = macdConditionShort();
                                divergencyCondition = divergencyConditionShort(buyIndex);
                                ({currentPrice, penetrationCondition} = await penetrationConditionShort(buyIndex))
                                console.log('divergencyCondition: ', divergencyCondition)

                                keepTrying = false
                            } catch{
                                console.log('ERROR WHEN FETCHING TIME')
                                await wait(5000)
                                keepTrying = true
                            }
                        } while (keepTrying)

                        if (buyIndex && (emaCondition || divergencyCondition) && macdCondition && penetrationCondition) {
                            logConditions(buyIndex, emaCondition, divergencyCondition, macdCondition, penetrationCondition, 'short')      
                            console.log('Confirmed conditions short!')
                            // не покупать на хаях
                            if (inputIndicators.psar[buyIndex-1-1] - currentPrice < 70) {
                                console.log(`Не хаи. CurrentPrice: ${currentPrice} diff ${inputIndicators.psar[buyIndex-1-1] - currentPrice}` )
                                console.log(`${ticker} Price: `, currentPrice); 
                                let keepTrying
                                do {
                                    try {
                                        await enterShort(currentPrice, buyArrayShort, Time, buyIndex)
                                        keepTrying = false
                                    } catch(e) {
                                        console.error('ERROR WHEN ENTERING SHORT')
                                        await wait(5000)
                                        keepTrying = true
                                    }
                                } while(keepTrying)
                            } else {
                                console.log(`Не покупаем на хаях. CurrentPrice: ${currentPrice} diff ${inputIndicators.psar[buyIndex-1-1] - currentPrice}`)
                            } 
                        } else {
                            console.log('unconfirmed conditions short!')
                            logConditions(buyIndex, emaCondition, macdCondition, penetrationCondition, 'short')      
                        }
                        beingExecutedEnterShort = false

                    } else {
                        console.log('already entered short here')
                    }
                }
            })()
        }
        

        //////////////!
        ///           !
        /// EXITS     !
        ///           !
        //////////////!

        //            !
        // EXIT long  !
        //            !
        if (inputIndicators.psar[inputIndicators.psar.length-1] > inputIndicators.high[inputIndicators.high.length-1] && inputIndicators.psar[inputIndicators.psar.length-2] <= inputIndicators.low[inputIndicators.low.length-2]) {
            let TestTime = new Date().toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")
            console.log('\n', 'EXIT LONG INFO')
            console.log(`PSAR long exit signal now at ${TestTime}`)
            if (buyArrayLong.length != 0) { // make sure we bought at least once
                let prices
                let currentPrice
                let keepTrying
                do {
                    try {
                        prices = await binanceClient.fetchTicker(ticker) 
                        currentPrice = prices.last
                        keepTrying = false
                    } catch(e) {
                        console.error('ERROR DURING SELL LONG PRICE FETCHING: ', e)
                        await wait(5000)
                        keepTrying = true
                    }
                } while(keepTrying)
                let Time = new Date()
                let notSoldArr = []
                for (let arr of buyArrayLong) {
                    //console.log('for sell loop check')
                    let profit = (currentPrice/arr[0]-1) *100
                    if(profit > 0) {      
                        let keepTrying
                        do {
                            try {
                                let {errorDidNotWork, notSold} = await exitLong(arr[0], arr[1], arr[2], arr[3], arr[4], currentPrice, Time)
                                if (notSold) {
                                    notSoldArr.push(notSold)
                                }
                                keepTrying = false                         
                            } catch(e) {
                                console.error('Error when exit long', e)
                                await wait(5000)
                                keepTrying = true
                            }
                        } while (keepTrying)
                    } else {
                        notSoldArr.push([arr[0], arr[1], arr[2], arr[3],arr[4]])
                        console.log(`negative profit at long enter ${arr[0]} at ${arr[1].toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")} long exit ${currentPrice} at ${Time}`)
                    }
                }
                if (notSoldArr.length < buyArrayLong.length) {
                    console.log('buyArrayLong is: ', buyArrayLong)
                    buyArrayLong = notSoldArr
                    console.log('After sell newBuyArrayLong is: ', buyArrayLong)
                }
            } else {
                console.log('we didnt enter long yet')
            }
            
        }
        ///takeprofit & stoploss logic long
        if(buyArrayLong.length != 0) {
            console.log('\n', 'TAKEPROFIT & STOPLOSS LONG INFO')
            let Time = new Date() 
            let notSoldArrAtStoploss = []
            for (let arr of buyArrayLong) {
                let prices
                let currentPrice
                let keepTrying
                do {
                    try {
                        prices = await binanceClient.fetchTicker(ticker) 
                        currentPrice = prices.last
                        keepTrying = false
                    } catch(e) {
                        console.error('ERROR DURING SELL LONG PRICE FETCHING: ', e)
                        await wait(5000)
                        keepTrying = true
                    }
                } while (keepTrying)
                if ((arr[3] >= currentPrice && Time - arr[1] >= 15*60*1000) || (arr[4] <= currentPrice)) {
                    let keepTrying
                    do {
                        try {
                            let {errorDidNotWork, notSold} = await exitLong(arr[0], arr[1], arr[2], arr[3], arr[4],currentPrice,Time)
                            if (notSold) {
                                notSoldArrAtStoploss.push(notSold)
                            }
                            keepTrying = false    
                        } catch(e) {
                            console.error('Error when exit long at stoploss', e)
                            await wait(5000)
                            keepTrying = true
                        }
                    } while (keepTrying)
                } else {
                    console.log('did not hit stoploss')
                    let stoploss
                    if (currentPrice - arr[0] > 55 && arr[3] != arr[0]) {
                        stoploss = arr[0]
                        bot.sendMessage(startMsg.chat.id, `replacing stoploss for ${arr[0]}, ${arr[1].toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")}, amount ${arr[2]}, stoploss ${stoploss}, takeProfit ${arr[4]}`)
                        console.log(`replacing stoploss ${stoploss}`)
                    } else {
                        stoploss = arr[3]
                    }
                    notSoldArrAtStoploss.push([arr[0], arr[1], arr[2], stoploss, arr[4]])
                }
            }
            if (notSoldArrAtStoploss.length <= buyArrayLong.length) {
                console.log('buyArrayLong was: ', buyArrayLong)
                buyArrayLong = notSoldArrAtStoploss
                console.log('NewbuyArrayLong is: ', buyArrayLong)   
            }  
        }


        //            !
        // EXIT short !
        //            !
        if (inputIndicators.psar[inputIndicators.psar.length-1] < inputIndicators.low[inputIndicators.low.length-1] && inputIndicators.psar[inputIndicators.psar.length-2] >= inputIndicators.high[inputIndicators.high.length-2]) {
            let TestTime = new Date().toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")
            console.log('\n', 'EXIT SHORT INFO')
            console.log(`PSAR short exit signal now at ${TestTime}`)
            if (buyArrayShort.length != 0) { // make sure we bought at least once
                let prices
                let currentPrice
                let keepTrying
                do {
                    try {
                        prices = await binanceClient.fetchTicker(ticker) 
                        currentPrice = prices.last
                        keepTrying = false
                    } catch(e) {
                        console.error('ERROR DURING SELL SHORT PRICE FETCHING: ', e)
                        await wait(5000)
                        keepTrying = true
                    }
                } while(keepTrying)
                let Time = new Date() 
                let notSoldArr = []
                for (let arr of buyArrayShort) {
                    //console.log('for sell loop check')
                    let profit = (arr[0]/currentPrice-1) *100
                    if(profit > 0) {
                        let keepTrying
                        do {
                            try {
                                let {errorDidNotWork, notSold} = await exitShort(arr[0], arr[1], arr[2], arr[3], arr[4], currentPrice, Time)
                                if (notSold) {
                                    notSoldArr.push(notSold)
                                }
                                keepTrying = false
                            } catch(e) {
                                console.error('Error when exit short', e)
                                await wait(5000)
                                keepTrying = true
                            }
                        } while (keepTrying)
                    } else {
                        notSoldArr.push([arr[0], arr[1],arr[2], arr[3], arr[4]])
                        console.log(`negative profit at short enter ${arr[0]} at ${arr[1].toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")} short exit ${currentPrice} at ${Time}`)
                    }
                }
                if (notSoldArr.length < buyArrayShort.length) {
                    console.log('buyArrayShort is: ', buyArrayShort)
                    buyArrayShort = notSoldArr
                    console.log('After sell newBuyArrayShort is: ', buyArrayShort)
                }
            } else {
                console.log('we didnt enter short yet')
            }
            
        }
        ///takeprofit & stoploss logic short
        if(buyArrayShort.length != 0) {
            console.log('\n', `TAKEPROFIT & STOPLOSS EXIT SHORT INFO`)
            let Time = new Date() 
            let notSoldArrAtStoploss = []
            for (let arr of buyArrayShort) {
                let prices
                let currentPrice
                let keepTrying
                do{
                    try {
                        prices = await binanceClient.fetchTicker(ticker) 
                        currentPrice = prices.last
                        keepTrying = false
                    } catch(e) {
                        console.error('ERROR DURING SELL SHORT PRICE FETCHING: ', e)
                        await wait(5000)
                        keepTrying = true
                    }
                } while (keepTrying)

                if ((arr[3] <= currentPrice && Time - arr[1] >= 15*60*1000) || (arr[4] >= currentPrice)) {
                    let keepTrying
                    do {
                        try {
                            let {errorDidNotWork, notSold}  = await exitShort(arr[0], arr[1], arr[2], arr[3], arr[4], currentPrice, Time)
                            if (notSold) {
                                notSoldArrAtStoploss.push(notSold)
                            }
                            keepTrying = false    
                        } catch(e) {
                            console.error('Error when exit short at stoploss', e)
                            await wait(5000)
                            keepTrying = true
                        }
                    } while(keepTrying)
                } else {
                    console.log('did not hit stoploss')
                    let stoploss
                    if (arr[0] - currentPrice > 55 && arr[3] != arr[0]) {
                        stoploss = arr[0]
                        console.log(`replacing stoploss ${stoploss}`)
                        bot.sendMessage(startMsg.chat.id, `replacing stoploss for ${arr[0]}, ${arr[1].toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")}, amount ${arr[2]}, stoploss ${stoploss}, takeProfit ${arr[4]}`)
                    } else {
                        stoploss = arr[3]
                    }
                    notSoldArrAtStoploss.push([arr[0], arr[1], arr[2], stoploss, arr[4]])
                }
            }
            if (notSoldArrAtStoploss.length <= buyArrayShort.length) {
                console.log('buyArrayShort was: ', buyArrayShort)
                buyArrayShort = notSoldArrAtStoploss
                console.log('NewBuyArrayShort is: ', buyArrayShort)
            }
        }
        try {
            await sync();
        } catch(e) {
            console.error('ERROR DURING SYNC: ', e);
        }
    }
}

bot.on("polling_error", console.log);

let isStarted = null

const checkPermission = (msg) => {
    let allowedPerson
    let allowedChat
    for (let id of allowedIds) {
        if (msg.chat.id === id) {
            allowedChat = true
        }
        if (msg.from.id === id) {
            allowedPerson = true
        }
    }
    return {allowedPerson, allowedChat}
}

bot.onText(/\/start/, (msg) => {
    let {allowedPerson, allowedChat} = checkPermission(msg)
    if (allowedChat && allowedPerson) {
        if (!isStarted) {
            startMsg = msg
            isStarted = true
            if (!startTime) {
                startTime = new Date()
            }
            console.log(`Started at ${startTime}`)
            run = true
            main()
            bot.sendMessage(msg.chat.id, "Running!")
        } else {
            bot.sendMessage(msg.chat.id, "Already running")
        }
    } else {
        bot.sendMessage(msg.chat.id, "You are not allowed to use this bot")
        bot.sendMessage(422689325, `Some bitch with chatId ${msg.chat.id} fromId ${msg.from.id} tried to use the bot. Text ${msg.text}`)   
    }
    
});

bot.onText(/\/stop/, (msg) => {
    let {allowedPerson, allowedChat} = checkPermission(msg)
    if (allowedChat && allowedPerson) {
        if (isStarted) {
            isStarted = false
            let stopTime = new Date()
            console.log(`Stopped at ${stopTime}`)
            run = false
            bot.sendMessage(msg.chat.id, "Stopped!")
            if (statistics.length != 0) {
                let statisticsJson = JSON.stringify(statistics, null, 2)
                fs.writeFile('../statistics.json', statisticsJson, err => {
                    if (err) {
                        console.log('error witing statistics')
                    } else {
                        console.log('Successfully wrote statistics')
                        bot.sendDocument(msg.chat.id, "../statistics.json")
                    }
                })
            } else {
                bot.sendMessage(msg.chat.id, `no statistics yet`)
            }
            if (buyArrayLong.length != 0) {
                let unsoldLongJson = JSON.stringify(buyArrayLong, null, 2)
                fs.writeFile('../unsoldLong.json', unsoldLongJson, err => {
                    if (err) {
                        console.log('error witing unsoldLong')
                    } else {
                        console.log('Successfully wrote unsold long')
                        bot.sendDocument(msg.chat.id, "../unsoldLong.json")
                    }
                })
            } else {
                bot.sendMessage(msg.chat.id, `no unsold long yet`)
            }
            if (buyArrayShort.length != 0) {
                let unsoldShortJson = JSON.stringify(buyArrayShort, null, 2)
                fs.writeFile('../unsoldShort.json', unsoldShortJson, err => {
                    if (err) {
                        console.log('error witing unsoldShort')
                    } else {
                        console.log('Successfully wrote unsold short')
                        bot.sendDocument(msg.chat.id, "../unsoldShort.json")
                    }
                })
            } else {
                bot.sendMessage(msg.chat.id, `no unsold short yet`)
            }
            accumulatedProfit = 0
            accumulatedProfitBUSD = 0
            for (let i = 0; i < profits.length; i++) {
                accumulatedProfit = accumulatedProfit+profits[i][0]
                accumulatedProfitBUSD = accumulatedProfitBUSD+profits[i][1]
            }
            bot.sendMessage(msg.chat.id, ` Accumulated profit is: ${accumulatedProfit}% ${accumulatedProfitBUSD}$ from ${startTime} UTC`)
        } else {
            bot.sendMessage(msg.chat.id, `Is not started yet`)
        }
    } else {
        bot.sendMessage(msg.chat.id, "You are not allowed to use this bot")
        bot.sendMessage(422689325, `Some bitch with chatId ${msg.chat.id} fromId ${msg.from.id} tried to use the bot. Text ${msg.text}`) 
    }
});

bot.onText(/\/statistics/, async (msg) => {
    let {allowedPerson, allowedChat} = checkPermission(msg)
    if (allowedChat && allowedPerson) {
        if (statistics.length != 0) {
            let statisticsJson = JSON.stringify(statistics, null, 2)
            fs.writeFile('../statistics.json', statisticsJson, err => {
                if (err) {
                    console.log('error witing statistics')
                } else {
                    console.log('Successfully wrote statistics')
                    bot.sendDocument(msg.chat.id, "../statistics.json")
                }
            })
        } else {
            bot.sendMessage(msg.chat.id, `no statistics yet`)
        }
    } else {
        bot.sendMessage(msg.chat.id, "You are not allowed to use this bot")
        bot.sendMessage(422689325, `Some bitch with chatId ${msg.chat.id} fromId ${msg.from.id} tried to use the bot. Text ${msg.text}`) 
    }
});

bot.onText(/\/unsold/, async (msg) => {
    let {allowedPerson, allowedChat} = checkPermission(msg)
    if (allowedChat && allowedPerson) {
        if (buyArrayLong.length != 0) {
            let unsoldLongJson = JSON.stringify(buyArrayLong, null, 2)
            fs.writeFile('../unsoldLong.json', unsoldLongJson, err => {
                if (err) {
                    console.log('error witing unsoldLong')
                } else {
                    console.log('Successfully wrote unsold long')
                    bot.sendDocument(msg.chat.id, "../unsoldLong.json")
                }
            })
        }  else {
            bot.sendMessage(msg.chat.id, `no unsold long yet`)
        }
        if (buyArrayShort.length != 0) {
            let unsoldShortJson = JSON.stringify(buyArrayShort, null, 2)
            fs.writeFile('../unsoldShort.json', unsoldShortJson, err => {
                if (err) {
                    console.log('error witing unsoldShort')
                } else {
                    console.log('Successfully wrote unsold short')
                    bot.sendDocument(msg.chat.id, "../unsoldShort.json")
                }
            })
        } else {
            bot.sendMessage(msg.chat.id, `no unsold short yet`)
        }
    } else {
        bot.sendMessage(msg.chat.id, "You are not allowed to use this bot")
        bot.sendMessage(422689325, `Some bitch with chatId ${msg.chat.id} fromId ${msg.from.id} tried to use the bot. Text ${msg.text}`) 
    }
});

bot.onText(/\/profit/, async (msg) => {
    let {allowedPerson, allowedChat} = checkPermission(msg)
    if (allowedChat && allowedPerson) {
        accumulatedProfit = 0
        accumulatedProfitBUSD = 0
        for (let i = 0; i < profits.length; i++) {
            accumulatedProfit = accumulatedProfit+profits[i][0]
            accumulatedProfitBUSD = accumulatedProfitBUSD+profits[i][1]
        }
        bot.sendMessage(msg.chat.id, ` Accumulated profit is: ${accumulatedProfit}%, ${accumulatedProfitBUSD} from ${startTime}`)
    } else {
        bot.sendMessage(msg.chat.id, "You are not allowed to use this bot")
        bot.sendMessage(422689325, `Some bitch with chatId ${msg.chat.id} fromId ${msg.from.id} tried to use the bot. Text ${msg.text}`) 
    }
});

bot.onText(/\/clearunsold/, async (msg) => {
    let {allowedPerson, allowedChat} = checkPermission(msg)
    if (allowedChat && allowedPerson) {
        if (buyArrayLong.length != 0) {
            let balanceBUSDToBeRestored = 0
            for (let buy of buyArrayLong) {
                balanceBUSDToBeRestored =  balanceBUSDToBeRestored + buy[2]*buy[0]
            }
            availableBalanceBUSD = availableBalanceBUSD + balanceBUSDToBeRestored
            buyArrayLong = []
            bot.sendMessage(msg.chat.id, `Long buyArray cleared!`)
        } else {
            bot.sendMessage(msg.chat.id, `Long buyArray is already empty`)
        }
        if (buyArrayShort.length != 0) {
            let balanceBTCToBeRestored = 0
            for (let buy of buyArrayShort) {
                balanceBTCToBeRestored =  balanceBTCToBeRestored + buy[2]
            }
            availableBalanceBTC = availableBalanceBTC + balanceBTCToBeRestored
            buyArrayShort = []
            bot.sendMessage(msg.chat.id, `Short buyArray cleared!`)
        } else {
            bot.sendMessage(msg.chat.id, `Short buyArray is already empty`)
        }
        
    } else {
        bot.sendMessage(msg.chat.id, "You are not allowed to use this bot")
        bot.sendMessage(422689325, `Some bitch with chatId ${msg.chat.id} fromId ${msg.from.id} tried to use the bot. Text ${msg.text}`) 

    }
});

bot.onText(/\/enterlong/, async msg => {
    let {allowedPerson, allowedChat} = checkPermission(msg)
    if (allowedChat && allowedPerson) {
        let Time = new Date()
        console.log('\n', 'ENTERING LONG MANUALLY')
        let prices
        let currentPrice
        let keepTrying 
        do {
            try{ 
                prices = await binanceClient.fetchTicker(ticker) 
                currentPrice = prices.last
                keepTrying = false
            } catch {
                keepTrying = true
            }
        } while(keepTrying)
        let {errorDidNotWork, errorEnteredTooManyTimes, errorInCalculatingEnterQuantity} = await enterLong(currentPrice, buyArrayLong, Time)
        if (errorDidNotWork) {
            bot.sendMessage(msg.chat.id, `Order did not work`) 
        }
        if (errorEnteredTooManyTimes) {
            bot.sendMessage(msg.chat.id, `Error! Entered too many times`) 
        }
        if (errorInCalculatingEnterQuantity) {
            bot.sendMessage(msg.chat.id, `Error! Did not manage to calculate enter quantity`) 
        }  
    } else {
        bot.sendMessage(msg.chat.id, "You are not allowed to use this bot")
        bot.sendMessage(422689325, `Some bitch with chatId ${msg.chat.id} fromId ${msg.from.id} tried to use the bot. Text ${msg.text}`) 
    }
});

bot.onText(/\/entershort/, async msg => {
    let {allowedPerson, allowedChat} = checkPermission(msg)
    if (allowedChat && allowedPerson) {
        let Time = new Date()
        console.log('\n', 'ENTERING SHORT MANUALLY')
        let prices
        let currentPrice
        let keepTrying 
        do {
            try{ 
                prices = await binanceClient.fetchTicker(ticker) 
                currentPrice = prices.last
                keepTrying = false
            } catch {
                keepTrying = true
            }
        } while(keepTrying)
        let {errorDidNotWork, errorEnteredTooManyTimes, errorInCalculatingEnterQuantity} = await enterShort(currentPrice, buyArrayShort, Time)
        if (errorDidNotWork) {
            bot.sendMessage(msg.chat.id, `Order did not work`) 
        }
        if (errorEnteredTooManyTimes) {
            bot.sendMessage(msg.chat.id, `Error! Entered too many times`) 
        }
        if (errorInCalculatingEnterQuantity) {
            bot.sendMessage(msg.chat.id, `Error! Did not manage to calculate enter quantity`) 
        }  
    } else {
        bot.sendMessage(msg.chat.id, "You are not allowed to use this bot")
        bot.sendMessage(422689325, `Some bitch with chatId ${msg.chat.id} fromId ${msg.from.id} tried to use the bot. Text ${msg.text}`) 
    }
});
bot.onText(/\/exitlong/, async msg => {
    let {allowedPerson, allowedChat} = checkPermission(msg)
    if (allowedChat && allowedPerson) {
        if(buyArrayLong.length != 0) {
            console.log('\n', 'SELLING LONG MANUALLY')
            let Time = new Date() 
            let notSoldArrManually = []
            let error
            for (let arr of buyArrayLong) {
                let prices
                let currentPrice
                let keepTrying
                do {
                    try {
                        prices = await binanceClient.fetchTicker(ticker) 
                        currentPrice = prices.last
                        keepTrying = false
                        let {errorDidNotWork, notSold} = await exitLong(arr[0], arr[1], arr[2], arr[3], arr[4],currentPrice,Time)
                        error = errorDidNotWork
                        if (notSold) {
                            notSoldArrManually.push(notSold)
                        }                    
                        keepTrying = false    
                    } catch(e) {
                        console.error('Error when exit long at stoploss', e)
                        await wait(5000)
                        keepTrying = true
                    }
                } while (keepTrying)
            }
            console.log('buy array long: ', buyArrayLong)
            console.log('notSoldArrManually: ',notSoldArrManually)
            if (notSoldArrManually.length < buyArrayLong.length) {
                console.log('buyArrayLong was: ', buyArrayLong)
                buyArrayLong = notSoldArrManually
                console.log('NewbuyArrayLong is: ', buyArrayLong)   
            }  
            if(error) {
                bot.sendMessage(msg.chat.id, `Exit long did not work`)  
            }
        } else {
            bot.sendMessage(msg.chat.id, `We did not enter long yet`)  
        }
    } else {
        bot.sendMessage(msg.chat.id, "You are not allowed to use this bot")
        bot.sendMessage(422689325, `Some bitch with chatId ${msg.chat.id} fromId ${msg.from.id} tried to use the bot. Text ${msg.text}`)  
    }
});
bot.onText(/\/exitshort/, async msg => {
    let {allowedPerson, allowedChat} = checkPermission(msg)
        if (allowedChat && allowedPerson) {
        if(buyArrayShort.length != 0) {
            console.log('\n', 'SELLING SHORT MANUALLY')
            let Time = new Date() 
            let notSoldArrManually = []
            let error
            for (let arr of buyArrayShort) {
                let prices
                let currentPrice
                let keepTrying
                do{
                    try {
                        prices = await binanceClient.fetchTicker(ticker) 
                        currentPrice = prices.last
                        keepTrying = false
                        let {errorDidNotWork, notSold}  = await exitShort(arr[0], arr[1], arr[2], arr[3], arr[4], currentPrice, Time)
                        if (notSold) {
                            notSoldArrManually.push(notSold)
                        }         
                        error = errorDidNotWork
                        keepTrying = false    
                    } catch(e) {
                        console.error('Error when exit short at stoploss', e)
                        await wait(5000)
                        keepTrying = true
                    }
                } while(keepTrying)
            }
            if (notSoldArrManually.length <= buyArrayShort.length) {
            console.log('buyArrayShort was: ', buyArrayShort)
            buyArrayShort = notSoldArrManually
            console.log('NewBuyArrayShort is: ', buyArrayShort)
            }
            if(error) {
                bot.sendMessage(msg.chat.id, `Exit short did not work`)  
            }
        } else {
            bot.sendMessage(msg.chat.id, `We did not enter short yet`)  
        }
    } else {
        bot.sendMessage(msg.chat.id, "You are not allowed to use this bot")
        bot.sendMessage(422689325, `Some bitch with chatId ${msg.chat.id} fromId ${msg.from.id} tried to use the bot. Text ${msg.text}`) 
    }
});