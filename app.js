'use srtict'
const tulind = require('tulind');
let path = require('path');
const ccxt = require ('ccxt');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

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
    ema: []
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const sync = async () => {
	//console.log('SYNCING ...');
	let serverTime = await binanceClient.fetchTime();
    let timeTillTheEndOfTheMinute = 20000 - (serverTime % 20000);
    await wait(timeTillTheEndOfTheMinute+18000); // delay to get most accorate data in a minute frame
}

const initializeInputIndicators = async() => {
    //console.log(' ')
    //console.log(`UPDATING INPUT ${new Date(Date.now())}`);
    let candles = await binanceClient.fetchOHLCV('BTC/USDT','1m')
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
    tulind.indicators.psar.indicator([inputIndicators.high, inputIndicators.low],[0.02,0.2],(err,res) => {
        if(err) return console.log(err);
        inputIndicators.psar = res[0];
    })
    //console.log('PSAR: ', inputIndicators.psar.slice(-2))

}
const calculateEMA = async() => {
    tulind.indicators.ema.indicator([inputIndicators.close],[100],(err,res) => {
        if(err) return console.log(err);
        inputIndicators.ema = res[0];
    })
    //console.log('EMA: ', inputIndicators.ema.slice(-2))

}

const calculateBuyQuantity = async () => {
	console.log('CALCULATING BUY QUANTITY');
	let accountInfo = await binanceClient.fetchBalance();
	let USDTBalance = accountInfo['USDT'].free;
	if(USDTBalance > 15){
		USDTBalance = 15;
	}
	console.log('USDT balance: ', USDTBalance);
	let prices = await binanceClient.fetchTicker('BTC/USDT')
	let currentPrice = prices.last;
	console.log('BTC Price: ', currentPrice);        
	let buyQuantity = (USDTBalance / currentPrice);
	buyQuantity = Math.ceil(buyQuantity * 100000) / 100000;
	console.log('BuyQuantity: ', buyQuantity, '\n');
	return { 
		buyQuantity,
		currentPrice
	};
}
let buyOrderInfo = null
let sellOrderInfo = null
let ORDER_UPDATE_PERIOD = 2000

const makeBuyOrder = async (buyQuantity, currentPrice) => {
	console.log('MAKING BUY ORDER');
	buyOrderInfo = await binanceClient.createOrder('BTC/USDT', 'limit', 'buy', buyQuantity, currentPrice)
	console.log('buyOrderInfo: ', buyOrderInfo, '\n');
}

const waitBuyOrderCompletion = async () => {
	console.log('WAITING BUY ORDER COMPLETION');
	for(let i = 0; i < 7; i++){
		buyOrderInfo = await binanceClient.fetchOrder(buyOrderInfo.id, 'BTC/USDT')
		console.log('status', buyOrderInfo.status)
		if(buyOrderInfo.status === 'closed'){
			console.log('PURCHASE COMPLETE! \n');
            let buyTime = new Date()
            let msg = 'success'
			return {msg, buyTime};
		}
        console.log('waiting...')
		await wait(ORDER_UPDATE_PERIOD);
	}
	console.log('status', buyOrderInfo.status)
	console.log('PURCHASE TIMED OUT, CANCELLING \n');
	await binanceClient.cancelOrder(buyOrderInfo.id, 'BTC/USDT')
    let buyTime = new Date()
    let msg = 'failure'
	return {msg, buyTime};
}

const buy = async () => {
	console.log('BUYING');     
	let { buyQuantity, currentPrice } = await calculateBuyQuantity();
	await makeBuyOrder(buyQuantity, currentPrice);
	let {msg, buyTime} = await waitBuyOrderCompletion();
	return {msg, buyQuantity, currentPrice, buyTime};
}

const makeSellOrder = async (sellQuantity, currentPrice) => {
	console.log('MAKING SELL ORDER');
	sellOrderInfo = await binanceClient.createOrder('BTC/USDT', 'limit', 'sell', sellQuantity, currentPrice)
	console.log('sellOrderInfo: ', sellOrderInfo, '\n');
}

const waitSellOrderCompletion = async () => {
	console.log('WAITING SELL ORDER COMPLETION');
	for(let i = 0; i < 7; i++){
		sellOrderInfo = await binanceClient.fetchOrder(sellOrderInfo.id, 'BTC/USDT')
		console.log('status', sellOrderInfo.status)
		if(sellOrderInfo.status === 'closed'){
			console.log('SALE COMPLETE! \n');
            let sellTime = new Date()
            let msg = 'success'
			return {msg, sellTime};
		}
        console.log('waiting...')
		await wait(ORDER_UPDATE_PERIOD);
	}
	console.log('status', sellOrderInfo.status)
	console.log('SALE TIMED OUT, CANCELLING \n');
	await binanceClient.cancelOrder(sellOrderInfo.id, 'BTC/USDT')
    let sellTime = new Date()
    let msg = 'failure'
	return {msg, sellTime};
}

const sell = async (sellQuantity, currentPrice) => {
	console.log('SELLING!');     
	await makeSellOrder(sellQuantity, currentPrice);
	let {msg, sellTime} = await waitSellOrderCompletion();
	return {msg, sellQuantity, currentPrice, sellTime};
}


const indicatorTest = async() => {
    //wait till 18sec, 38sec or 58sec when started
    try {
		await sync();
    } catch(e) {
        console.error('ERROR DURING SYNC: ', e);
    }

    let statistics = []
    let profits = []
    let buyArray = []
    let epoches = 6
    
    while(true){
        //getting OHLC
        try {
			await initializeInputIndicators();
		} catch (e) {
			console.error('ERROR IN initializeInputIndicators: ', e);
		}
        //PSAR and EMA
        try {
			await calculatePSAR();
            await calculateEMA();
		} catch (e) {
			console.error('ERROR IN calculateIndicators: ', e);
		}
        // checking last number of epoches on PSAR buy signal
        for (let i = inputIndicators.high.length-1; i > inputIndicators.high.length-epoches; i--) {
            //since number of PSARS in array is different, creating corresponding index for psar
            let iPSAR = i-1
            //logic to find PSAR buy signal
            if (inputIndicators.psar[iPSAR] < inputIndicators.low[i] && inputIndicators.psar[iPSAR-1] >= inputIndicators.high[i-1]) {
                //writing index where signal occured
                let buyIndex = i
                //console.log(' ')
                console.log(`PSAR buy signal ${inputIndicators.high.length-1-buyIndex} epoches ago`)
                // logic to check on current candle penetration of the previous PSAR
                if ((inputIndicators.candleType[inputIndicators.candleType.length-1] == "red" && inputIndicators.open[inputIndicators.open.length-1] > inputIndicators.psar[buyIndex-1-1]) || (inputIndicators.candleType[inputIndicators.candleType.length-1] == "green" && inputIndicators.close[inputIndicators.close.length-1] > inputIndicators.psar[buyIndex-1-1])) {
                    console.log(`Прострел!. Current CandleType: ${inputIndicators.candleType[inputIndicators.candleType.length-1]}, Open: ${inputIndicators.open[inputIndicators.open.length-1]}, Close: ${inputIndicators.close[inputIndicators.close.length-1]}, Psar before signal: ${inputIndicators.psar[buyIndex-1-1]}`)
                    //logic to check on PSAR before signal location relatively to EMA 
                    if (inputIndicators.psar[buyIndex-1-1] > inputIndicators.ema[buyIndex-1]) {
                        console.log(`prev psar indicator находится выше!. Ema: ${inputIndicators.ema[buyIndex-1]}, prev Psar: ${inputIndicators.psar[buyIndex-1-1]}` )
                        let Time = new Date()
                        let alreadyBought = false
                        //
                        if (buyArray.length != 0 ) {
                            for (let arr of buyArray) {
                                if (Time-arr[1] < 430000 ) {
                                    alreadyBought = true 
                                    break
                                } 
                            }
                        }
                        if (alreadyBought == false) {
                            console.log(`Buying... At ${Time}`)
                            try {
                                let {msg, buyQuantity, currentPrice, buyTime} = await buy()
                                if (msg == 'success') {
                                    console.log(' ')
                                    console.log(`bought at ${currentPrice} ${buyTime.toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")} amount ${buyQuantity}`)
                                    buyArray.push([currentPrice, buyTime, buyQuantity])
                                    console.log('buyArray:', buyArray)
                                } else if (msg == 'failure') {
                                    console.log(`order did not work at ${currentPrice} ${buyTime.toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")} amount ${buyQuantity}`)
                                }
                            } catch (e) {
                                console.error('Error when buying', e)
                            }
                        } else {
                            console.log('already bougth here')
                        }
                    } else {
                        console.log(`prev psar indicator находится ниже ema. Ema: ${inputIndicators.ema[buyIndex-1]}, prev Psar: ${inputIndicators.psar[buyIndex-1-1]}` )
                    }
                } else {
                    console.log(`нет прострела. Current CandleType: ${inputIndicators.candleType[inputIndicators.candleType.length-1]}, Open: ${inputIndicators.open[inputIndicators.open.length-1]}, Close: ${inputIndicators.close[inputIndicators.close.length-1]}, Psar before signal: ${inputIndicators.psar[buyIndex-1-1]}`)
                }
            } 
        }
        if (inputIndicators.psar[inputIndicators.psar.length-1] > inputIndicators.high[inputIndicators.high.length-1] && inputIndicators.psar[inputIndicators.psar.length-2] <= inputIndicators.low[inputIndicators.low.length-2]) {
            //console.log(`PSAR sell signal now`)
            if (buyArray.length != 0) { // make sure we bought at least once
                let prices
                try {
                    prices = await binanceClient.fetchTicker('BTC/USDT') 
                } catch(e) {
                    console.error('ERROR DURING SELL PRICE FETCHING: ', e)
                }
                let sellPrice = prices.last
                let Time = new Date()
                Time = Time.toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")
                let notSoldArr = []
                for (let arr of buyArray) {
                    //console.log('for sell loop check')
                    let profit = (sellPrice/arr[0]-1) *100
                    if(profit > 0) {
                        console.log(`Selling at ${Time}`)
                        try {
                            let {msg, sellQuantity, currentPrice, sellTime} = await sell(arr[2], sellPrice)
                            if (msg == 'success') {
                                console.log(`sold at ${currentPrice} ${sellTime} amount ${sellQuantity}(buy ${arr[0]} at ${arr[1].toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")} amount ${arr[2]})`)
                                statistics.push(`buy ${arr[0]} at ${arr[1]}`)
                                statistics.push(`sell ${sellPrice} at ${sellTime}`)
                                statistics.push(`profit ${profit}`)
                                profits.push(profit)
                            } else if (msg == 'failure') {
                                notSoldArr.push([arr[0], arr[1]])
                            }                            
                        } catch(e) {
                            console.erroe('Error when selling', e)
                        }
                    } else {
                        notSoldArr.push([arr[0], arr[1]])
                        //console.log(`negative profit at buy ${arr[0]} at ${arr[1].toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")} sell ${sellPrice} at ${sellTime.toLocaleTimeString().replace("/.*(\d{2}:\d{2}:\d{2}).*/", "$1")}`)
                    }
                }
                if (notSoldArr.length < buyArray.length) {
                    let accumulatedProfit = 0
                    for (let i = 0; i < profits.length; i++) {
                        accumulatedProfit = accumulatedProfit+profits[i]
                    }
                    console.log(`accumulatedProfit is ${accumulatedProfit}`)
                    console.log('statistics: ', statistics)
                    console.log('BuyArray is: ', buyArray)
                    buyArray = notSoldArr
                    console.log('After sell newBuyArray is: ', buyArray)
                }
            } else {
                //console.log('we didnt  buy yet')
            }
            
        } 
        try {
            await sync();
        } catch(e) {
            console.error('ERROR DURING SYNC: ', e);
        }
    }
}
indicatorTest()
