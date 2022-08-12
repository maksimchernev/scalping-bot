'use srtict'
process.env.NTBA_FIX_319 = 1;
process.env.NTBA_FIX_350 = 1;
const tulind = require('tulind');
let path = require('path');
const ccxt = require ('ccxt');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const fs = require('fs')
const TelegramBot = require('node-telegram-bot-api');
const token = process.env.TG_KEY;
const bot = new TelegramBot(token, {polling: true});


let startMsg
const candleTypeRange = 5
const ticker = 'BTC/USDT'
let availableBalanceUSDT = 1300
let availableBalanceBTC = 0.059

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
    console.log(`Updating at ${time}`);
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
    tulind.indicators.ema.indicator([inputIndicators.close],[100],(err,res) => {
        if(err) return console.log(err);
        inputIndicators.ema = res[0];
    })
}
const calculateMACD = async() => {
    tulind.indicators.macd.indicator([inputIndicators.close],[12,26,9],(err,res) => {
        if(err) return log(err);
        inputIndicators.macd = res[0];
        inputIndicators.macdSignal = res[1];
      });
}

const calculateEnterQuantity = async (buyArray, Time, direction) => {
	console.log('CALCULATING ENTER QUANTITY');

    let prices = await binanceClient.fetchTicker(ticker)
    
    let enterQuantity
    let currentPrice
    let recentBuyArray = []
    if(buyArray.length != 0) {
        for (let arr of buyArray) {
            if (Time - arr[1] < 3*60*60*1000) {
                recentBuyArray.push(arr)
            }
        }
    }
    if (direction == 'long') {
        currentPrice = 0.9999*prices.last;
        console.log(`${ticker} Price: `, currentPrice); 

        if (recentBuyArray.length == 0){
            enterQuantity = availableBalanceUSDT
        } else {
            enterQuantity = 0
        }
        if (enterQuantity < 15) {
            enterQuantity = 0
        }
        enterQuantity = Math.floor(enterQuantity)
        console.log('EnterQuantity long: ', enterQuantity);
    } else if (direction == 'short') {
        currentPrice = 1.00001 *prices.last;
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
    return { 
        enterQuantity,
        currentPrice
    };
	
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
    let usdtAmount
    if (direction == 'long') {
        console.log('WAITING BUY LONG ORDER COMPLETION');
        for(let i = 0; i < 7; i++){
            buyLongOrderInfo = await binanceClient.fetchOrder(buyLongOrderInfo.id, ticker)
            console.log('long order status', buyLongOrderInfo.status)
            if(buyLongOrderInfo.status === 'closed'){
                console.log('LONG ORDER PURCHASE COMPLETE! \n');
                buyQuantity = buyLongOrderInfo.amount
                buyPrice = buyLongOrderInfo.average
                usdtAmount = buyLongOrderInfo.cost
                buyTime = new Date()
                msg = 'success'
                return {msg, buyQuantity, buyPrice, buyTime, usdtAmount};
            }
            console.log('long order waiting...')
            await wait(ORDER_UPDATE_PERIOD);
        }
        console.log('long order status', buyLongOrderInfo.status)
        console.log('LONG ORDER PURCHASE TIMED OUT, CANCELLING \n');

        try {
            await binanceClient.cancelOrder(buyLongOrderInfo.id, ticker)
        } catch(e) {
            console.log('ERROR CANCELLING')
        }
        buyLongOrderInfo = await binanceClient.fetchOrder(buyLongOrderInfo.id, ticker)
        if (buyLongOrderInfo.status === 'canceled') {
            usdtAmount = null
            buyQuantity = null
            buyPrice = null
            buyTime = new Date()
            msg = 'failure'
        } else if (buyLongOrderInfo.status === 'closed') {
            console.log('LONG ORDER PURCHASE COMPLETE AT DOUBLE CHECK! \n');
            buyQuantity = buyLongOrderInfo.amount
            buyPrice = buyLongOrderInfo.average
            usdtAmount = buyLongOrderInfo.cost
            buyTime = new Date()
            msg = 'success'
        }
        return {msg, buyQuantity, buyPrice, buyTime, usdtAmount};

    } else if (direction == 'short') {
        console.log('WAITING BUY SHORT ORDER COMPLETION');
        for(let i = 0; i < 7; i++){
            buyShortOrderInfo = await binanceClient.fetchOrder(buyShortOrderInfo.id, ticker)
            console.log('short order status', buyShortOrderInfo.status)
            if(buyShortOrderInfo.status === 'closed'){
                console.log('SHORT ORDER PURCHASE COMPLETE! \n');
                buyQuantity = buyShortOrderInfo.amount
                buyPrice = buyShortOrderInfo.average
                usdtAmount = buyShortOrderInfo.cost
                buyTime = new Date()
                msg = 'success'
                return {msg, buyQuantity, buyPrice, buyTime, usdtAmount};
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
        if (buyShortOrderInfo.status === 'canceled') {
            usdtAmount = null
            buyQuantity = null
            buyPrice = null
            buyTime = new Date()
            msg = 'failure'
        } else if (buyShortOrderInfo.status === 'closed') {
            console.log('SHORT ORDER PURCHASE COMPLETE AT DOUBLE CHECK! \n');
            buyQuantity = buyShortOrderInfo.amount
            buyPrice = buyShortOrderInfo.average
            usdtAmount = buyShortOrderInfo.cost
            buyTime = new Date()
            msg = 'success'
        }
        return {msg, buyQuantity, buyPrice, buyTime, usdtAmount};
    } else {
        console.log('unknown direction')
        usdtAmount = null
        buyQuantity = null
        buyPrice = null
        buyTime = new Date()
        msg = 'failure'
        return {msg, buyQuantity, buyPrice, buyTime, usdtAmount};
    }
 	
}

const buy = async (enterQuantity, currentPrice, direction) => {
	console.log('BUYING');     
	await makeBuyOrder(enterQuantity, currentPrice, direction);
	let {msg, buyQuantity, buyPrice, buyTime, usdtAmount} = await waitBuyOrderCompletion(direction);
	return {msg, buyQuantity, buyPrice, buyTime, usdtAmount};
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
    let usdtAmount
    if (direction == 'long') {
        console.log('WAITING LONG EXIT ORDER COMPLETION');
        for(let i = 0; i < 7; i++){
            sellLongOrderInfo = await binanceClient.fetchOrder(sellLongOrderInfo.id, ticker)
            console.log('status', sellLongOrderInfo.status)
            if(sellLongOrderInfo.status === 'closed'){
                console.log('LONG EXIT COMPLETE! \n');
                sellQuantity = sellLongOrderInfo.amount
                sellPrice = sellLongOrderInfo.average
                usdtAmount = sellLongOrderInfo.cost
                sellTime = new Date()
                msg = 'success'
                return {msg, sellQuantity, sellPrice, sellTime, usdtAmount};
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
        if (sellLongOrderInfo.status === 'canceled') {
            usdtAmount = null
            sellQuantity = null
            sellPrice = null
            sellTime = new Date()
            msg = 'failure'
        } else if (sellLongOrderInfo.status === 'closed') {
            console.log('LONG ORDER EXIT COMPLETE AT DOUBLE CHECK! \n');
            sellQuantity = sellLongOrderInfo.amount
            sellPrice = sellLongOrderInfo.average
            usdtAmount = sellLongOrderInfo.cost
            sellTime = new Date()
            msg = 'success'
        }
        return {msg, sellQuantity, sellPrice, sellTime, usdtAmount};

    } else if (direction == 'short') {
        console.log('WAITING SHORT EXIT ORDER COMPLETION');
        for(let i = 0; i < 7; i++){
            sellShortOrderInfo = await binanceClient.fetchOrder(sellShortOrderInfo.id, ticker)
            console.log('status', sellShortOrderInfo.status)
            if(sellShortOrderInfo.status === 'closed'){
                console.log('SHORT EXIT COMPLETE! \n');
                usdtAmount = sellShortOrderInfo.cost
                sellQuantity = sellShortOrderInfo.amount
                sellPrice = sellShortOrderInfo.average
                sellTime = new Date()
                msg = 'success'
                return {msg, sellQuantity, sellPrice, sellTime, usdtAmount};
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
        if (sellShortOrderInfo.status === 'canceled') {
            usdtAmount = null
            sellQuantity = null
            sellPrice = null
            sellTime = new Date()
            msg = 'failure'
        } else if (sellShortOrderInfo.status === 'closed') {
            console.log('SHORT ORDER EXIT COMPLETE AT DOUBLE CHECK! \n');
            sellQuantity = sellShortOrderInfo.amount
            sellPrice = sellShortOrderInfo.average
            usdtAmount = sellShortOrderInfo.cost
            sellTime = new Date()
            msg = 'success'
        }
        return {msg, sellQuantity, sellPrice, sellTime, usdtAmount};
    } else {
        console.log('unknown direction')
        usdtAmount = null
        sellQuantity = null
        sellPrice = null
        sellTime = new Date()
        msg = 'failure'
        return {msg, sellQuantity, sellPrice, sellTime, usdtAmount};
    }
}

const sell = async (exitQuantity, currentPrice, direction) => {
    console.log('SELLING!');     
    await makeSellOrder(exitQuantity, currentPrice, direction);
    let {msg, sellQuantity, sellPrice, sellTime, usdtAmount} = await waitSellOrderCompletion(direction);
    return {msg, sellQuantity, sellPrice, sellTime, usdtAmount};
}

let run
let statistics = []
let buyArrayLong = []
let buyArrayShort = []
let profits = []
let startTime
let accumulatedProfit = 0
let accumulatedProfitUSDT = 0

const enterLong = async (buyArrayLong, Time, buyIndex) => {
    let errorDidNotWork
    let errorEnteredTooManyTimes
    let errorInCalculatingEnterQuantity
    console.log(`Buying long... At ${Time}`)                     
    let {enterQuantity, currentPrice} = await calculateEnterQuantity(buyArrayLong, Time, 'long')//in USDT
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
            let usdtAmount = 1300 */
            errorEnteredTooManyTimes = false 
            let {msg, buyQuantity, buyPrice, buyTime, usdtAmount} = await buy(enterQuantity, currentPrice, 'long')
            if (msg === 'success') {
                errorDidNotWork = false
                availableBalanceUSDT = availableBalanceUSDT - usdtAmount
                console.log(' ')
                let stoploss
            
                if(buyIndex != undefined) {
                    if (buyPrice - inputIndicators.psar[buyIndex-1] > 100) {
                        stoploss = buyPrice - ((buyPrice - inputIndicators.psar[buyIndex-1]) *0.7)
                    } else if (buyPrice - inputIndicators.psar[buyIndex-1] <50) {
                        stoploss = buyPrice - 50
                    } else {
                        stoploss = inputIndicators.psar[buyIndex -1]
                    }
                } else {
                    stoploss = buyPrice - 100
                }
                    
                bot.sendMessage(startMsg.chat.id, `enter long ${buyPrice}, ${buyTime.toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")}, amount ${buyQuantity}, stoploss ${stoploss}`)
                console.log(`enter long ${buyPrice}, ${buyTime.toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")}, amount ${buyQuantity}, stoploss ${stoploss}`)
                buyArrayLong.push([buyPrice, buyTime, buyQuantity, stoploss])
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
const enterShort = async (buyArrayShort, Time, buyIndex) => {
    let errorDidNotWork
    let errorEnteredTooManyTimes
    let errorInCalculatingEnterQuantity
    console.log(`Buying short... At ${Time}`)
    let {enterQuantity, currentPrice} = await calculateEnterQuantity(buyArrayShort, Time, 'short')//in BTC
    if (enterQuantity !=undefined && currentPrice != undefined) {
        errorInCalculatingEnterQuantity = false
        enterQuantity = Math.floor(enterQuantity * 100000) / 100000; // to 5 numbers after 0
        if (enterQuantity != 0) {
            errorEnteredTooManyTimes = false
/*             let msg = 'success'
            let buyQuantity = enterQuantity
            let buyPrice = currentPrice
            let buyTime = Time
            let usdtAmount = 1300  */
            let {msg, buyQuantity, buyPrice, buyTime, usdtAmount} = await buy(enterQuantity, currentPrice, 'short')
            if (msg == 'success') {
                errorDidNotWork = false
                availableBalanceBTC = availableBalanceBTC - buyQuantity
                console.log(' ')
                let stoploss
                if(buyIndex != undefined) {
                    if (inputIndicators.psar[buyIndex-1] - buyPrice  > 100) {
                        stoploss = buyPrice + ((inputIndicators.psar[buyIndex-1] - buyPrice)*0.7)
                    } else if (inputIndicators.psar[buyIndex-1] - buyPrice  < 50){
                        stoploss = buyPrice+50
                    } else {
                        stoploss = inputIndicators.psar[buyIndex -1]
                    }
                } else {
                    stoploss = buyPrice + 100
                }
                
                bot.sendMessage(startMsg.chat.id, `enter short ${buyPrice} ${buyTime.toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")}, amount ${buyQuantity}, stop loss ${stoploss}`)
                console.log(`enter short ${buyPrice} ${buyTime.toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")}, amount ${buyQuantity}, stop loss ${stoploss}`)
                buyArrayShort.push([buyPrice, buyTime, buyQuantity, stoploss])
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
const exitLong = async (buyPrice, buyTime, buyQuantity, stoploss, currentPrice, currentTime) => {
/*     let msg = 'success'
    let sellQuantity = buyQuantity
    let sellPrice = currentPrice
    let sellTime = currentTime
    let usdtAmount = 1300  */
    let errorDidNotWork
    console.log(`Exiting long at ${currentTime}`)
    let notSold
    let {msg, sellQuantity, sellPrice, sellTime, usdtAmount} = await sell(buyQuantity, currentPrice, 'long')

    if (msg == 'success') {
        errorDidNotWork = false
        availableBalanceUSDT = availableBalanceUSDT + usdtAmount
        bot.sendMessage(startMsg.chat.id, `exit long ${sellPrice} ${sellTime} amount ${sellQuantity}(buy ${buyPrice} at ${buyTime.toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")} amount ${buyQuantity})`)
        console.log(`exit long ${sellPrice} ${sellTime} amount ${sellQuantity}(buy ${buyPrice} at ${buyTime.toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")} amount ${buyQuantity})`)
        statistics.push(`enter long ${buyPrice} at ${buyTime} amount ${buyQuantity}`)
        statistics.push(`exit long ${sellPrice} at ${sellTime} amount ${sellQuantity}`)
        let profit = (sellPrice/buyPrice-1) *100
        let usdtProfit = buyPrice*buyQuantity*((sellPrice/buyPrice)-1)
        statistics.push(`long profit(loss) ${profit}% ${usdtProfit}$`)
        profits.push([profit, usdtProfit])
    } else if (msg == 'failure') {
        errorDidNotWork = true
        notSold = [buyPrice, buyTime, buyQuantity, stoploss]
        console.log(`Exit long order did not work. Buy price ${buyPrice} at ${buyTime.toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")} sell ${sellPrice} at ${currentTime}`)
    }   
    return {errorDidNotWork, notSold}
}
const exitShort = async (buyPrice, buyTime, buyQuantity, stoploss, currentPrice, currentTime) => {
/*     let msg = 'success'
    let sellQuantity = buyQuantity
    let sellPrice = currentPrice
    let sellTime = currentTime
    let usdtAmount = 1300  */
    let errorDidNotWork
    console.log(`Exiting short at ${currentTime}`)
    let notSold
    let {msg, sellQuantity, sellPrice, sellTime, usdtAmount} = await sell(buyQuantity, currentPrice, 'short')

    if (msg == 'success') {
        errorDidNotWork = false
        availableBalanceBTC = availableBalanceBTC + sellQuantity
        bot.sendMessage(startMsg.chat.id, `exit short ${sellPrice} ${sellTime} amount ${sellQuantity}(buy ${buyPrice} at ${buyTime.toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")} amount ${buyQuantity})`)
        console.log(`exit short ${sellPrice} ${sellTime} amount ${sellQuantity}(enter ${buyPrice} at ${buyTime.toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")} amount ${buyQuantity})`)
        statistics.push(`enter short ${buyPrice} at ${buyTime} amount ${buyQuantity}`)
        statistics.push(`exit short ${sellPrice} at ${sellTime} amount ${sellQuantity}`)
        let profit = (buyPrice/sellPrice-1) *100
        let usdtProfit = sellQuantity*sellPrice*((buyPrice/sellPrice)-1)
        statistics.push(`short profit ${profit}% ${usdtProfit}$`)
        profits.push([profit, usdtProfit])
    } else if (msg == 'failure') {
        errorDidNotWork = true
        notSold = [buyPrice, buyTime, buyQuantity, stoploss]
        console.log(`Exit short order did not work. Enter short ${buyPrice} at ${buyTime.toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")} sell ${sellPrice} at ${currentTime}`)
    }     
    return {errorDidNotWork, notSold}                    
}
const main = async() => {
    //wait till 18sec, 38sec or 58sec when started
    try {
		await sync();
    } catch(e) {
        console.error('ERROR DURING SYNC: ', e);
    }
    
    let epoches = 3
    
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

        //trend check
        // checking last number of epoches on PSAR buy signal
        //            !
        // Enter long !
        //            !
        for (let i = inputIndicators.high.length-1; i >= inputIndicators.high.length-1-epoches; i--) {
            //since number of PSARS in array is different, creating corresponding index for psar
            let iPSAR = i-1
            let TestTime = new Date().toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")
            //logic to find PSAR buy signal
            if (inputIndicators.psar[iPSAR] < inputIndicators.low[i] && inputIndicators.psar[iPSAR-1] >= inputIndicators.high[i-1]) {
                //writing index where signal occured
                let buyIndex = i
                console.log('\n', 'ENTER LONG INFO')
                console.log(`PSAR long enter signal ${inputIndicators.high.length-1-buyIndex} epoches ago at ${TestTime}`)
                // logic to check on current candle penetration of the previous PSAR
                if ((inputIndicators.candleType[inputIndicators.candleType.length-1] == "red" && inputIndicators.open[inputIndicators.open.length-1] > inputIndicators.psar[buyIndex-1-1]) || (inputIndicators.candleType[inputIndicators.candleType.length-1] == "green" && inputIndicators.close[inputIndicators.close.length-1] > inputIndicators.psar[buyIndex-1-1])) {
                    console.log('Прострел LONG!')

                    
                    //logic to check on PSAR before signal location relatively to EMA 
                    if (inputIndicators.psar[buyIndex-1-1] > inputIndicators.ema[buyIndex-1]) {
                        console.log(`Long! Prev psar indicator находится выше! Ema: ${inputIndicators.ema[buyIndex-1]}, prev Psar: ${inputIndicators.psar[buyIndex-1-1]}`)
                        if (inputIndicators.macd[inputIndicators.macd.length-1] > inputIndicators.macdSignal[inputIndicators.macdSignal.length-1]) {
                            console.log(`Macd is higher than mcd signal! Macd: ${inputIndicators.macd[inputIndicators.macd.length-1]}, Macd signal: ${inputIndicators.macdSignal[inputIndicators.macdSignal.length-1]}`)
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
                            if (alreadyBought == false) {
                                let keepTrying
                                do {
                                    try {
                                        await enterLong(buyArrayLong, Time, buyIndex)
                                        keepTrying = false
                                    } catch(e) {
                                        console.error('ERROR WHEN ENTERING LONG')
                                        await wait(5000)
                                        keepTrying = true
                                    }
                                } while (keepTrying)
                            } else {
                                console.log('already entered long here')
                            }
                        } else {
                            console.log(`macd is lower than macd signal. Macd: ${inputIndicators.macd[inputIndicators.macd.length-1]}, Macd signal: ${inputIndicators.macdSignal[inputIndicators.macdSignal.length-1]}`)
                        }                        
                    } else {
                        console.log(`prev psar indicator long находится ниже ema. Ema: ${inputIndicators.ema[buyIndex-1]}, prev Psar: ${inputIndicators.psar[buyIndex-1-1]}` )
                    }
                }
            } 
        }
        //             !
        // ENTER short !
        //             !
        //checking last number of epoches on PSAR sell signal
        for (let i = inputIndicators.low.length-1; i >= inputIndicators.low.length-1-epoches; i--) {
            //since number of PSARS in array is different, creating corresponding index for psar
            let iPSAR = i-1
            let TestTime = new Date().toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")
            //logic to find PSAR sell signal
            
                if (inputIndicators.psar[iPSAR] > inputIndicators.high[i] && inputIndicators.psar[iPSAR-1] <= inputIndicators.low[i-1]) {
                //writing index where signal occured
                let buyIndex = i
                console.log('\n', 'ENTER SHORT INFO')
                console.log(`PSAR short enter signal ${inputIndicators.low.length-1-buyIndex} epoches ago at ${TestTime}`)
                
                // logic to check on current candle penetration of the previous PSAR
                if ((inputIndicators.candleType[inputIndicators.candleType.length-1] == "red" && inputIndicators.close[inputIndicators.close.length-1] < inputIndicators.psar[buyIndex-1-1]) || (inputIndicators.candleType[inputIndicators.candleType.length-1] == "green" && inputIndicators.open[inputIndicators.open.length-1] < inputIndicators.psar[buyIndex-1-1])) {
                    console.log('Прострел SHORT')
                    
                    //logic to check on PSAR before signal location relatively to EMA 
                    if (inputIndicators.psar[buyIndex-1-1] < inputIndicators.ema[buyIndex-1]) {
                        console.log(`Short! Prev psar indicator находится ниже! Ema: ${inputIndicators.ema[buyIndex-1]}, prev Psar: ${inputIndicators.psar[buyIndex-1-1]}` )
                        if (inputIndicators.macd[inputIndicators.macd.length-1] < inputIndicators.macdSignal[inputIndicators.macdSignal.length-1]) {
                            console.log(`Macd is lower than mcd signal! Macd: ${inputIndicators.macd[inputIndicators.macd.length-1]}, Macd signal: ${inputIndicators.macdSignal[inputIndicators.macdSignal.length-1]}`)
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
                            if (alreadyBought == false) {
                                let keepTrying
                                do {
                                    try {
                                        await enterShort(buyArrayShort, Time, buyIndex)
                                        keepTrying = false
                                    } catch(e) {
                                        console.error('ERROR WHEN ENTERING SHORT')
                                        await wait(5000)
                                        keepTrying = true
                                    }
                                } while(keepTrying)
                            } else {
                                console.log('already entered short here')
                            }
                        } else {
                            console.log(`macd is higher than mcd signal. Macd: ${inputIndicators.macd[inputIndicators.macd.length-1]}, Macd signal: ${inputIndicators.macdSignal[inputIndicators.macdSignal.length-1]}`)
                        }
                    } else {
                        console.log(`prev psar indicator short находится выше ema. Ema: ${inputIndicators.ema[buyIndex-1]}, prev Psar: ${inputIndicators.psar[buyIndex-1-1]}` )
                    }
                }
            } 
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
                Time = Time.toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")
                let notSoldArr = []
                for (let arr of buyArrayLong) {
                    //console.log('for sell loop check')
                    let profit = (currentPrice/arr[0]-1) *100
                    if(profit > 0) {      
                        let keepTrying
                        do {
                            try {
                                let {errorDidNotWork, notSold} = await exitLong(arr[0], arr[1], arr[2], arr[3], currentPrice, Time)
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
                        notSoldArr.push([arr[0], arr[1], arr[2], arr[3]])
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
        ///stoploss logic long
        if(buyArrayLong.length != 0) {
            console.log('\n', 'STOPLOSS LONG INFO')
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
                if (arr[3] >= currentPrice && Time - arr[1] >= 15*60*1000) {
                    //TEST
/*                     let msg = 'success'
                    let sellQuantity = arr[2]
                    let sellTime = Time 
                    let sellPrice = currentPrice
                    let usdtAmount = 1300 */

                    let keepTrying
                    do {
                        try {
                            let {errorDidNotWork, notSold} = await exitLong(arr[0], arr[1], arr[2], arr[3],currentPrice,Time)
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
                    if (currentPrice - arr[0] > 50) {
                        stoploss = arr[0]
                        console.log(`replacing stoploss ${stoploss}`)
                    } else {
                        console.log('not replacing stoploss')
                        stoploss = arr[3]
                    }
                    notSoldArrAtStoploss.push([arr[0], arr[1], arr[2], stoploss])
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
                Time = Time.toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")
                let notSoldArr = []
                for (let arr of buyArrayShort) {
                    //console.log('for sell loop check')
                    let profit = (arr[0]/currentPrice-1) *100
                    if(profit > 0) {
                        let keepTrying
                        do {
                            try {
                                let {errorDidNotWork, notSold} = await exitShort(arr[0], arr[1], arr[2], arr[3], currentPrice, Time)
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
                        notSoldArr.push([arr[0], arr[1],arr[2], arr[3]])
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
        ///stoploss logic short
        if(buyArrayShort.length != 0) {
            console.log('\n', `STOPLOSS EXIT SHORT INFO`)
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

                if (arr[3] <= currentPrice && Time - arr[1] >= 15*60*1000) {
                    let keepTrying
                    do {
                        try {
                            let {errorDidNotWork, notSold}  = await exitShort(arr[0], arr[1], arr[2], arr[3], currentPrice, Time)
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
                    if (arr[0] - currentPrice > 50) {
                        stoploss = arr[0]
                        console.log(`replacing stoploss ${stoploss}`)
                    } else {
                        stoploss = arr[3]
                    }
                    notSoldArrAtStoploss.push([arr[0], arr[1], arr[2], stoploss])
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


bot.onText(/\/start/, (msg) => {
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
});

bot.onText(/\/stop/, (msg) => {
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
        accumulatedProfitUSDT = 0
        for (let i = 0; i < profits.length; i++) {
            accumulatedProfit = accumulatedProfit+profits[i][0]
            accumulatedProfitUSDT = accumulatedProfitUSDT+profits[i][1]
        }
        bot.sendMessage(msg.chat.id, ` Accumulated profit is: ${accumulatedProfit}% ${accumulatedProfitUSDT}$ from ${startTime} UTC`)
    } else {
        bot.sendMessage(msg.chat.id, `Is not started yet`)
    }
});

bot.onText(/\/statistics/, (msg) => {
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
});

bot.onText(/\/unsold/, (msg) => {
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
});

bot.onText(/\/profit/, (msg) => {
    accumulatedProfit = 0
    accumulatedProfitUSDT = 0
    for (let i = 0; i < profits.length; i++) {
        accumulatedProfit = accumulatedProfit+profits[i][0]
        accumulatedProfitUSDT = accumulatedProfitUSDT+profits[i][1]
    }
    bot.sendMessage(msg.chat.id, ` Accumulated profit is: ${accumulatedProfit}%, ${accumulatedProfitUSDT} from ${startTime}`)
});

bot.onText(/\/clearunsold/, (msg) => {
    buyArrayShort = []
    buyArrayLong = []
    bot.sendMessage(msg.chat.id, `Cleared!`)
});

bot.onText(/\/enterlong/, async msg => {
    let Time = new Date()
    console.log('\n', 'ENTERING LONG MANUALLY')
    let {errorDidNotWork, errorEnteredTooManyTimes, errorInCalculatingEnterQuantity} = await enterLong(buyArrayLong, Time)
    if (errorDidNotWork) {
        bot.sendMessage(msg.chat.id, `Order did not work`) 
    }
    if (errorEnteredTooManyTimes) {
        bot.sendMessage(msg.chat.id, `Error! Entered too many times`) 
    }
    if (errorInCalculatingEnterQuantity) {
        bot.sendMessage(msg.chat.id, `Error! Did not manage to calculate enter quantity`) 
    }  
});

bot.onText(/\/entershort/, async msg => {
    let Time = new Date()
    console.log('\n', 'ENTERING SHORT MANUALLY')
    let {errorDidNotWork, errorEnteredTooManyTimes, errorInCalculatingEnterQuantity} = await enterShort(buyArrayShort, Time)
    if (errorDidNotWork) {
        bot.sendMessage(msg.chat.id, `Order did not work`) 
    }
    if (errorEnteredTooManyTimes) {
        bot.sendMessage(msg.chat.id, `Error! Entered too many times`) 
    }
    if (errorInCalculatingEnterQuantity) {
        bot.sendMessage(msg.chat.id, `Error! Did not manage to calculate enter quantity`) 
    }  
});
bot.onText(/\/exitlong/, async msg => {
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
                    let {errorDidNotWork, notSold} = await exitLong(arr[0], arr[1], arr[2], arr[3],currentPrice,Time)
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
});
bot.onText(/\/exitshort/, async msg => {
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
                    let {errorDidNotWork, notSold}  = await exitShort(arr[0], arr[1], arr[2], arr[3], currentPrice, Time)
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
        bot.sendMessage(msg.chat.id, `We did not enter long yet`)  
    }
});