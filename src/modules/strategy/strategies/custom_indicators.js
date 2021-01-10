/*
 * This strategy demos how to use various kind of indicators:
 * - builtin indicators - see full list of indicators here https://github.com/Haehnchen/crypto-trading-bot/blob/bd078b0612bf21e39df027798bec79e03c884024/src/utils/indicators.js#L138
 * - custom tulind indicators, not included in builtin file
 * - custom indicators defined locally
 */

const SignalResult = require('../dict/signal_result');

module.exports = class CustomIndicatorsStrategy {
  getName() {
    return 'example_custom_indicators';
  }

  buildIndicator(indicatorBuilder, { sma_length, tema_length, period, left, right }) {
    // Build in indicator - pivot points
    indicatorBuilder.add('pivot_points', 'pivot_points_high_low', period, { left: left, right: right });

    // Calculate sustom indicators defined bellow as functions
    indicatorBuilder.add('highPoint', this.pivothigh, period, {}, 'pivot_points');
    indicatorBuilder.add('mySMA', this.tvSMA, period, { length: sma_length });

    // call helper function from indicators.js
    indicatorBuilder.add('sma', 'sma', period, { length: tema_length });

    // tulind indicators expect parameters as arrays, so we need to wrap "length" to array.
    indicatorBuilder.add('tema', 'tulind', period, { indicator: 'tema', options: [tema_length] });

    // example of very complex tulind indicator:
    indicatorBuilder.add('tulindStoch', 'tulind', period, {
      indicator: 'stoch',
      sources: ['high', 'low', 'close'],
      options: [21, 5, 5],
      results: ['stoch_k', 'stoch_d']
    });
  }

  async period(indicatorPeriod, options) {
    const result = SignalResult.createEmptySignal({});
    // extract indicator values
    const { _candle, mySMA, tema, highPoint, tulindStoch } = indicatorPeriod.indicators; // <-- here we can access indicator results

    // ....  my strategy logic - buy on Sunday, sell on Tuesday :)
    if (new Date(_candle.time * 1000).getDay() === 0) {
      result.setSignal('long');
    }
    if (new Date(_candle.time * 1000).getDay() === 2) {
      result.setSignal('short');
    }

    // set result columns
    result.addDebug('highpoint', highPoint[0]);
    result.addDebug('tema', tema[0]);
    result.addDebug('sma', mySMA[0]);
    result.addDebug('tulindStoch', tulindStoch[0]);

    return result;
  }

  // OUR CUSTOM INDICATOR example 1:

  // @source - array of input values, default is close.
  // @indicator - object with indicator settings passed to indicator, basically it is equal to BuildIndicator result.
  // must return <Promise>
  // TradingView SMA:
  tvSMA(source, indicator) {
    return new Promise(resolve => {
      const { length } = indicator.options;
      resolve({
        [indicator.key]: source.map((s, i, arr) => {
          if (i < length - 1 || !s) return undefined;
          const filtered = arr.slice(i - length + 1, i + 1).filter(Boolean);
          return filtered.reduce((a, b) => a + b, 0) / filtered.length;
        })
      });
    });
  }

  // OUR CUSTOM INDICATOR example 2:
  // args and return same structure as example 1
  pivothigh(source, { key = 'pivothigh' }) {
    return new Promise(resolve => {
      resolve({ [key]: source.map(pp => pp.high && pp.high.high) });
    });
  }

  getBacktestColumns() {
    return [
      {
        label: 'SMA',
        value: 'sma',
        type: 'oscillator',
        range: [100, -100]
      },
      {
        label: 'highPoint',
        value: 'highPoint'
      },
      {
        label: 'tema',
        value: 'tema'
      },
      {
        label: 'tulindStoch',
        value: 'tulindStoch'
      }
    ];
  }

  getOptions() {
    return {
      period: '1h',
      sma_lenght: 6,
      tema_length: 6,
      left: 5,
      right: 5
    };
  }
};
