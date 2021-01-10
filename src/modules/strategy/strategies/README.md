# Strategies

## Custom strategies

For custom strategies use [var/strategies](var/strategies) folder.

```bash
# simple file structure
var/strategies/your_strategy.js

# or wrap strategy into any sub folder depth
var/strategies/my_strategy/my_strategy.js
var/strategies/subfolder1/our_strategy/our_strategy.js
```

## Demo strategies

Find some example strategies inside [modules/strategy/strategies](modules/strategy/strategies)

### strategy use_custom_indicators

This strategy demos how to use various kind of indicators:

- builtin indicators - see full list of [indicators here](https://github.com/Haehnchen/crypto-trading-bot/blob/bd078b0612bf21e39df027798bec79e03c884024/src/utils/indicators.js#L138)
- custom [tulind indicators](https://www.npmjs.com/package/tulind), not included in builtin file. Indicators list with parametrs [here](https://tulipindicators.org/list)
- custom indicators defined locally
