// https://docs.ccxt.com/#/exchanges/cryptocom

const crypto = require('crypto-js');
const WebSocket = require('ws');
const ccxt = require('ccxt');
// const ccxtPro = require('ccxt').pro;
const moment = require('moment');
const _ = require('lodash');
const querystring = require('querystring');
const request = require('request');
const Candlestick = require('../dict/candlestick');
const Ticker = require('../dict/ticker');
const Order = require('../dict/order');
const TickerEvent = require('../event/ticker_event');
const ExchangeCandlestick = require('../dict/exchange_candlestick');
const Position = require('../dict/position');
const CcxtExchangeOrder = require('./ccxt/ccxt_exchange_order');
const CommonUtil = require('../utils/common_util');

module.exports = class CryptoComExchange {
  constructor(eventEmitter, requestClient, candlestickResample, logger, queue, candleImporter, throttler) {
    this.eventEmitter = eventEmitter;
    this.logger = logger;
    this.queue = queue;
    this.candleImporter = candleImporter;
    this.throttler = throttler;
    this.exchange = null;

    this.ccxtExchangeOrder = CcxtExchangeOrder.createEmpty(logger);

    this.positions = {};
    this.balances = {};
    this.orders = {};
    this.tickers = {};
    this.symbols = [];
    this.intervals = [];
    this.ccxtClient = undefined;
  }

  backfill(symbol, period, start) {
    const symbolUpdated = symbol.replace('PERP', '');

    return new Promise((resolve, reject) => {
      const query = querystring.stringify({
        timeframe: period,
        instrument_name: symbolUpdated,
        count: 500,
        start_ts: moment(start).valueOf()
      });

      console.log(`${this.getBaseUrl()}public/get-candlestick?${query}`);

      request(`${this.getBaseUrl()}public/get-candlestick?${query}`, { json: true }, (err, res, body) => {
        if (err) {
          console.log(`CryptoCom: Candle backfill error: ${String(err)}`);
          reject();
          return;
        }

        if (res.statusCode === 429) {
          console.log(`CryptoCom: Limit reached: ${String(res.headers)}`);
          // TODO delay next execution
          reject();
          return;
        }

        const { result } = body;
        if (!result || !Object.prototype.hasOwnProperty.call(result, 'data') || !Array.isArray(result.data)) {
          console.log(`CryptoCom: Candle backfill error: ${JSON.stringify(body)}`);
          reject();
          return;
        }

        resolve(
          result.data.map(({ t, o, h, l, c, v }) => {
            return new Candlestick(moment(t).format('X'), parseFloat(o), parseFloat(h), parseFloat(l), parseFloat(c), parseFloat(v));
          })
        );
      });
    });
  }

  start(config, symbols) {
    const { logger } = this;
    this.exchange = null;

    const ccxtClient = (this.ccxtClient = new ccxt.cryptocom({
      apiKey: config.key,
      secret: config.secret
      // options: { defaultType: 'future', warnOnFetchOpenOrdersWithoutSymbol: false }
    }));

    this.intervals = [];
    this.symbols = symbols;
    this.positions = {};
    this.orders = {};
    this.ccxtExchangeOrder = CryptoComExchange.createCustomCcxtOrderInstance(ccxtClient, symbols, logger);

    const me = this;

    if (config.key && config.secret && config.key.length > 0 && config.secret.length > 0) {
      //TODO: uncomment after testing
      // setInterval(async () => {
      //   me.throttler.addTask('cryptocom_sync_orders', async () => {
      //     await me.ccxtExchangeOrder.syncOrders();
      //   });
      // }, 1000 * 30);

      setInterval(async () => {
        me.throttler.addTask('cryptocom_sync_positions', me.syncPositionViaRestApi.bind(me));
      }, 1000 * 36);

      setTimeout(async () => {
        await ccxtClient.fetchMarkets();
        //TODO: uncomment after testing
        // me.throttler.addTask('cryptocom_sync_orders', async () => {
        //   await me.ccxtExchangeOrder.syncOrders();
        // });
        me.throttler.addTask('cryptocom_sync_positions', me.syncPositionViaRestApi.bind(me));
      }, 1000);

      setTimeout(async () => {
        await me.initUserWebsocket(config);
      }, 2000);

      setTimeout(async () => {
        await me.initPublicWebsocket(symbols);
      }, 5000);
    } else {
      me.logger.info(`${this.getName()}: Starting as anonymous; no trading possible`);
    }

    symbols.forEach(symbol => {
      symbol.periods.forEach(period => {
        // for bot init prefill data: load latest candles from api
        this.queue.add(async () => {
          let ohlcvs;

          try {
            ohlcvs = await ccxtClient.fetchOHLCV(symbol.symbol.replace('USDT', '_USDT'), period, undefined, 500);
            // ohlcvs = await ccxtClient.fetchOHLCV(symbol.symbol, period, undefined, 500);
          } catch (e) {
            me.logger.info(`${this.getName()}: candles fetch error: ${JSON.stringify([symbol.symbol, period, String(e)])}`);

            return;
          }

          const ourCandles = ohlcvs.map(candle => {
            return new ExchangeCandlestick(
              me.getName(),
              symbol.symbol,
              period,
              Math.round(candle[0] / 1000),
              candle[1],
              candle[2],
              candle[3],
              candle[4],
              candle[5]
            );
          });

          await me.candleImporter.insertThrottledCandles(ourCandles);
        });
      });
    });
  }

  /**
   * Updates all position; must be a full update not delta. Unknown current non orders are assumed to be closed
   *
   * @param positions Position
   */
  fullPositionsUpdate(positions) {
    const currentPositions = {};

    positions.forEach(position => {
      currentPositions[position.symbol] = position;
    });

    this.positions = currentPositions;
  }

  async getOrders() {
    return this.ccxtExchangeOrder.getOrders();
  }

  async findOrderById(id) {
    return this.ccxtExchangeOrder.findOrderById(id);
  }

  async getOrdersForSymbol(symbol) {
    return this.ccxtExchangeOrder.getOrdersForSymbol(symbol);
  }

  async getPositions() {
    return Object.values(this.positions).map(position => {
      // overwrite profits by ticker price from position; ticker prices are more fresh
      if (position.getEntry() && this.tickers[position.getSymbol()]) {
        const profit = position.isLong()
          ? (this.tickers[position.symbol].bid / position.entry - 1) * 100 // long profit
          : (position.entry / this.tickers[position.symbol].ask - 1) * 100; // short profit

        return Position.createProfitUpdate(position, profit);
      }

      return position;
    });
  }

  async getPositionForSymbol(symbol) {
    return (await this.getPositions()).find(position => position.symbol === symbol);
  }

  // eslint-disable-next-line no-unused-vars
  calculatePrice(price, symbol) {
    return price; // done by ccxt
  }

  // eslint-disable-next-line no-unused-vars
  calculateAmount(amount, symbol) {
    return amount; // done by ccxt
  }

  getName() {
    return 'cryptocom';
  }

  async order(order) {
    return this.ccxtExchangeOrder.createOrder(order);
  }

  async cancelOrder(id) {
    const result = this.ccxtExchangeOrder.cancelOrder(id);
    await this.ccxtExchangeOrder.syncOrders();
    return result;
  }

  async cancelAll(symbol) {
    const result = this.ccxtExchangeOrder.cancelAll(symbol);
    await this.ccxtExchangeOrder.syncOrders();
    return result;
  }

  async updateOrder(id, order) {
    if (!order.amount && !order.price) {
      throw new Error('Invalid amount / price for update');
    }

    const result = this.ccxtExchangeOrder.updateOrder(id, order);
    await this.ccxtExchangeOrder.syncOrders();
    return result;
  }

  /**
   * Convert incoming positions only if they are open
   *
   * @param positions
   * @returns {*}
   */
  static createPositions(positions) {
    return positions.map(position => {
      const positionAmt = parseFloat(position.positionAmt);

      const entryPrice = parseFloat(position.entryPrice);
      const markPrice = parseFloat(position.markPrice);

      const profit =
        positionAmt < 0
          ? (entryPrice / markPrice - 1) * 100 // short
          : (markPrice / entryPrice - 1) * 100; // long

      return new Position(
        position.symbol,
        positionAmt < 0 ? 'short' : 'long',
        positionAmt,
        parseFloat(profit.toFixed(2)), // round 2 numbers
        new Date(),
        entryPrice,
        undefined,
        position
      );
    });
  }

  /**
   * Convert incoming position only if they are open
   *
   * @param position
   * @returns {*}
   */
  static createPositionFromWebsocket(position) {
    const positionAmt = parseFloat(position.pa);
    const entryPrice = parseFloat(position.ep);

    return new Position(position.s, positionAmt < 0 ? 'short' : 'long', positionAmt, undefined, new Date(), entryPrice, undefined, position);
  }

  /**
   * Websocket position updates
   */
  accountUpdate(message) {
    if (message.a && message.a.P) {
      message.a.P.forEach(position => {
        if (!position.s || !position.ps || position.ps.toLowerCase() !== 'both') {
          return;
        }

        // position closed
        if (position.s in this.positions && position.pa === '0') {
          delete this.positions[position.s];

          this.logger.info(`${this.getName()}: Websocket position closed/removed: ${JSON.stringify([position.s, position])}`);

          return;
        }

        // position open
        if (
          !(position.s in this.positions) &&
          position.pa !== '0' &&
          (parseFloat(position.ep) > 0.00001 || parseFloat(position.ep) < -0.00001) // prevent float point issues
        ) {
          this.positions[position.s] = CryptoComExchange.createPositionFromWebsocket(position);

          this.logger.info(`${this.getName()}: Websocket position new found: ${JSON.stringify([position.s, position])}`);

          return;
        }

        // position update
        if (position.s in this.positions) {
          this.logger.info(
            `${this.getName()}: Websocket position update: ${JSON.stringify([position.s, position.pa, this.positions[position.s].getAmount()])}`
          );
        }
      }, this);
    }
  }

  /**
   * As a websocket fallback update orders also on REST
   */
  async syncPositionViaRestApi() {
    let response;
    try {
      response = await this.ccxtClient.fetchPositions();
    } catch (e) {
      this.logger.error(`${this.getName()}: error getting positions:${e}`);
      return;
    }

    const positions = response.filter(position => position.entryPrice && parseFloat(position.entryPrice) > 0);
    this.fullPositionsUpdate(CryptoComExchange.createPositions(positions));

    this.logger.debug(`${this.getName()}: positions updates: ${positions.length}`);
  }

  // eslint-disable-next-line no-unused-vars
  isInverseSymbol(symbol) {
    return false;
  }

  async initPublicWebsocket(symbols) {
    const me = this;

    const allSubscriptions = [];
    symbols.forEach(symbol => {
      allSubscriptions.push(`${symbol.symbol.toLowerCase()}@bookTicker`);
      allSubscriptions.push(...symbol.periods.map(p => `${symbol.symbol.toLowerCase()}@kline_${p}`));
    });

    me.logger.info(`${this.getName()}: Public stream subscriptions: ${allSubscriptions.length}`);

    // "A single connection can listen to a maximum of 200 streams."; let us have some window frames
    _.chunk(allSubscriptions, 180).forEach((allSubscriptionsChunk, indexConnection) => {
      me.initPublicWebsocketChunk(allSubscriptionsChunk, indexConnection);
    });
  }

  /**
   * A per websocket init function scope to filter maximum allowed subscriptions per connection
   * Endpoints list: https://exchange-docs.crypto.com/exchange/v1/rest-ws/index.html#websocket-root-endpoints
   *
   * @param {string[]} subscriptions
   * @param {int} indexConnection
   */
  initPublicWebsocketChunk(subscriptions, indexConnection) {
    const me = this;
    // const ws = new WebSocket('wss://uat-stream.3ona.co/exchange/v1/market'); // Sandbox
    const ws = new WebSocket('wss://stream.crypto.com/exchange/v1/market');

    ws.onerror = function (event) {
      me.logger.error(`${me.getName()}: Public stream (${indexConnection}) error: ${JSON.stringify([event.code, event.message])}`);
    };

    let subscriptionTimeouts = {};

    ws.onopen = function () {
      me.logger.info(`${me.getName()}: Public stream (${indexConnection}) opened.`);

      me.logger.info(`${me.getName()}: Needed Websocket (${indexConnection}) subscriptions: ${JSON.stringify(subscriptions.length)}`);

      // "we are only allowed to send 5 requests per second"; but limit it also for the "SUBSCRIBE" itself who knows upcoming changes on this
      _.chunk(subscriptions, 15).forEach((subscriptionChunk, index) => {
        subscriptionTimeouts[index] = setTimeout(() => {
          me.logger.debug(`${me.getName()}: Public stream (${indexConnection}) subscribing: ${JSON.stringify(subscriptionChunk)}`);

          ws.send(
            JSON.stringify({
              method: 'subscribe',
              params: subscriptionChunk,
              id: Math.floor(Math.random() * Math.floor(100))
            })
          );

          delete subscriptionTimeouts[index];
        }, (index + 1) * 1500);
      });
    };

    ws.onmessage = async function (event) {
      if (event.type && event.type === 'message') {
        const body = JSON.parse(event.data);

        const { method, id } = body;
        if (method && method.toLowerCase() === 'public/heartbeat') {
          me.logger.info(`${me.getName()}: Heartbeat`);
          ws.send(JSON.stringify({ id: id, method: 'public/respond-heartbeat' }));
        }
        if (body.stream && body.stream.toLowerCase().includes('@bookticker')) {
          me.eventEmitter.emit(
            'ticker',
            new TickerEvent(
              me.getName(),
              body.data.s,
              (me.tickers[body.data.s] = new Ticker(me.getName(), body.data.s, moment().format('X'), parseFloat(body.data.b), parseFloat(body.data.a)))
            )
          );
        } else if (body.stream && body.stream.toLowerCase().includes('@kline')) {
          await me.candleImporter.insertThrottledCandles([
            new ExchangeCandlestick(
              me.getName(),
              body.data.s,
              body.data.k.i,
              Math.round(body.data.k.t / 1000),
              parseFloat(body.data.k.o),
              parseFloat(body.data.k.h),
              parseFloat(body.data.k.l),
              parseFloat(body.data.k.c),
              parseFloat(body.data.k.v)
            )
          ]);
        }
      }
    };

    ws.onclose = function (event) {
      me.logger.error(`${me.getName()}: Public Stream (${indexConnection}) connection closed: ${JSON.stringify([event.code, event.message])}`);

      Object.values(subscriptionTimeouts).forEach(timeout => {
        clearTimeout(timeout);
      });

      subscriptionTimeouts = {};

      setTimeout(async () => {
        me.logger.info(`${me.getName()}: Public stream (${indexConnection}) connection reconnect`);
        await me.initPublicWebsocketChunk(subscriptions, indexConnection);
      }, 1000 * 30);
    };
  }

  async initUserWebsocket(config) {
    const me = this;
    const exchangeWS = new CryptoComUserWebsocket(config.key, config.secret);

    exchangeWS.ws.onerror = function (e) {
      me.logger.info(`${me.getName()}: Connection error: ${String(e)}`);
    };

    exchangeWS.ws.onmessage = async function (event) {
      if (event && event.type === 'message') {
        const message = JSON.parse(event.data);
        console.log(message);

        const { method, id, code, result } = message;
        if (method?.toLowerCase() === 'public/heartbeat') {
          me.logger.info(`${me.getName()}: Heartbeat`);
          exchangeWS.heartbeat(id);
        } else if (method?.toLowerCase() === 'public/auth') {
          if (code == 0) {
            me.logger.info(`${me.getName()}: Authenticated`);
            exchangeWS.subscribe(['user.order', 'user.positions', 'user.balance']);
          }
        } else if (method?.toLowerCase() === 'subscribe') {
          if (code == 0 && result?.channel === 'user.order' && result?.data?.length) {
            me.logger.info(`${me.getName()}: User orders update: ${JSON.stringify(result.data)}`);
            result.data.forEach(order => {
              // const order = me.ccxtClient.parseOrder(msgOrder);
              // const order = CryptoComExchange.createRestOrderFromWebsocket(msgOrder);
              me.ccxtExchangeOrder.triggerPlainOrder(order);
              me.logger.info(`${me.getName()}: User order update: ${JSON.stringify(order)}`);
            });
          } else if (code == 0 && result?.channel === 'user.balance' && result?.data?.length) {
            // console.log(`${me.getName()}: User balance update: ${result.data}`);
            me.balances = me.ccxtClient.parseBalance(message);
            // me.logger.info(`${me.getName()}: User balance update: ${JSON.stringify(me.balances)}`);
          }
        }

        if (message.e && message.e.toUpperCase() === 'ACCOUNT_UPDATE') {
          me.accountUpdate(message);

          me.throttler.addTask('cryptocom_sync_positions', me.syncPositionViaRestApi.bind(me), 3000);
        }
      }
    };

    const heartbeat = setInterval(async () => {
      try {
        await this.ccxtClient.fapiPrivatePutListenKey();
        this.logger.debug(`${this.getName()}: user stream ping successfully done`);
      } catch (e) {
        this.logger.error(`${this.getName()}: user stream ping error: ${String(e)}`);
      }
    }, 1000 * 60 * 10);

    exchangeWS.ws.onclose = function (event) {
      me.logger.error(`${me.getName()}: User stream connection closed: ${JSON.stringify([event.code, event.message])}`);
      clearInterval(heartbeat);

      setTimeout(async () => {
        me.logger.info(`${me.getName()}: User stream connection reconnect`);
        await me.initUserWebsocket(config);
      }, 1000 * 30);
    };

    return true;
  }

  static createCustomCcxtOrderInstance(ccxtClient, symbols, logger) {
    // ccxt id and binance ids are not matching
    const CcxtExchangeOrderExtends = class extends CcxtExchangeOrder {
      async createOrder(order) {
        order.symbol = order.symbol.replace('USDT', '/USDT');
        return super.createOrder(order);
      }
    };

    return new CcxtExchangeOrderExtends(ccxtClient, symbols, logger, {
      cancelOrder: (client, args) => {
        return { symbol: args.symbol.replace('USDT', '/USDT') };
      },
      convertOrder: (client, order) => {
        order.symbol = order.symbol.replace('/', '');

        // ccxt does not pipe the stopPrice
        if (['trailing_stop_market', 'stop_market'].includes(order.type) && order.info.stopPrice) {
          order.price = parseFloat(order.info.stopPrice);
        }
      },
      createOrder: order => {
        const request = {
          args: {}
        };

        if (order.isReduceOnly()) {
          request.args.reduceOnly = true;
        }

        if (order.getType() === Order.TYPE_STOP) {
          request.args.stopPrice = order.getPrice();
        }

        return request;
      }
    });
  }

  getBaseUrl() {
    return 'https://api.crypto.com/exchange/v1/'; // production
  }

  static createRestOrderFromWebsocket(websocketOrder) {
    const order = websocketOrder;

    // {
    //   account_id: '5288ac03-fc09-4382-97a2-9313c7eaa0fe',
    //   avg_price: '0',
    //   client_oid: 'oObEZubz8VDJ9AvN5CeVx',
    //   create_time: 1731335538437,
    //   create_time_ns: '1731335538437548606',
    //   cumulative_fee: '0',
    //   cumulative_quantity: '0',
    //   cumulative_value: '0',
    //   fee_instrument_name: 'USD',
    //   instrument_name: 'CORGIAI_USD',
    //   limit_price: '0.0049500',
    //   maker_fee_rate: '0',
    //   order_date: '2024-11-11',
    //   order_id: '4989988528327537574',
    //   order_type: 'LIMIT',
    //   order_value: '490.05',
    //   quantity: '99000',
    //   ref_price: '0',
    //   side: 'SELL',
    //   status: 'ACTIVE',
    //   taker_fee_rate: '0',
    //   time_in_force: 'GOOD_TILL_CANCEL',
    //   update_time: 1731335538437,
    //   update_user_id: '5288ac03-fc09-4382-97a2-9313c7eaa0fe'
    // };

    const map = {
      s: 'instrument_name',
      c: 'client_oid',
      S: 'side',
      o: 'order_type',
      f: 'time_in_force',
      q: 'quantity',
      p: 'limit_price',
      // sp: 'stopPrice',
      X: 'status',
      i: 'order_id',
      T: 'update_time',
      z: 'cumulative_quantity'
      // n: 'cumQuote' // not fully sure about commision
    };

    const newOrder = {};
    Object.keys(order).forEach(k => {
      if (map[k]) {
        newOrder[map[k]] = order[k];
      }
    });

    return newOrder;
  }

  static createPositionsWithOpenStateOnly(positions) {
    return positions
      .filter(position => ['short', 'long'].includes(position.side?.toLowerCase()))
      .map(position => {
        const side = position.side.toLowerCase();
        let size = position.contracts;

        if (side === 'short') {
          size *= -1;
        }

        return new Position(
          position.symbol,
          side,
          size,
          position.markPrice && position.entryPrice ? CommonUtil.getProfitAsPercent(side, position.markPrice, position.entryPrice) : undefined,
          new Date(),
          parseFloat(position.entryPrice),
          new Date(),
          position
        );
      });
  }
};

class CryptoComUserWebsocket {
  constructor(key, secret) {
    this.ws = new WebSocket(`wss://stream.crypto.com/exchange/v1/user`);
    this.key = key;
    this.secret = secret;
    this.ws.onopen = () => this.auth();
  }

  auth() {
    let request = {
      id: 1,
      method: 'public/auth',
      api_key: this.key,
      nonce: Date.now()
    };
    // generate sig.
    const { id, method, nonce } = request;
    const sigPayload = method + id + this.key + nonce;
    request.sig = crypto.HmacSHA256(sigPayload, this.secret).toString(crypto.enc.Hex);
    this.ws.send(JSON.stringify(request));
  }

  heartbeat(id) {
    this.ws.send(JSON.stringify({ id: id, method: 'public/respond-heartbeat' }));
  }

  subscribe(channels) {
    // Subscribe to orders and positions. ['user.order', 'user.positions']
    this.ws.send(
      JSON.stringify({
        method: 'subscribe',
        params: {
          channels: channels
        },
        id: Math.floor(Math.random() * Math.floor(100))
      })
    );
  }
}
