import os
import glob
import shutil

# First make sure lib/bitget.ts has the latest logic
shutil.copy2('c:/PROYECTOS/binance1/lib/binance.ts', 'c:/PROYECTOS/binance1/lib/bitget.ts')

# Now search all .ts files in app/api and replace binance with bitget
pattern = 'c:/PROYECTOS/binance1/app/api/**/*.ts'
files = glob.glob(pattern, recursive=True)

for file in files:
    with open(file, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # replace the import path
    content = content.replace("@/lib/binance", "@/lib/bitget")
    # replace function signatures
    content = content.replace("binanceGetPrice", "bitgetGetPrice")
    content = content.replace("binancePlaceMarketOrder", "bitgetPlaceMarketOrder")
    content = content.replace("binancePlaceStopMarket", "bitgetPlaceStopMarket")
    content = content.replace("binanceOrderSuccess", "bitgetOrderSuccess")
    content = content.replace("binanceClosePosition", "bitgetClosePosition")
    content = content.replace("binanceCancelAllOrders", "bitgetCancelAllOrders")
    content = content.replace("binanceGetExchangeInfo", "bitgetGetExchangeInfo")
    content = content.replace("binanceGetCommissionRate", "bitgetGetCommissionRate")
    content = content.replace("binanceNormalizeSymbol", "bitgetNormalizeSymbol")
    content = content.replace("binanceGetPositions", "bitgetGetPositions")

    with open(file, 'w', encoding='utf-8') as f:
        f.write(content)

print("Updated all routes!")

# Update lib/bitget.ts itself to also rename the exported functions
with open('c:/PROYECTOS/binance1/lib/bitget.ts', 'r', encoding='utf-8') as f:
    content = f.read()

content = content.replace("binanceGetPrice", "bitgetGetPrice")
content = content.replace("binancePlaceMarketOrder", "bitgetPlaceMarketOrder")
content = content.replace("binancePlaceStopMarket", "bitgetPlaceStopMarket")
content = content.replace("binanceOrderSuccess", "bitgetOrderSuccess")
content = content.replace("binanceClosePosition", "bitgetClosePosition")
content = content.replace("binanceCancelAllOrders", "bitgetCancelAllOrders")
content = content.replace("binanceGetExchangeInfo", "bitgetGetExchangeInfo")
content = content.replace("binanceGetCommissionRate", "bitgetGetCommissionRate")
content = content.replace("binanceNormalizeSymbol", "bitgetNormalizeSymbol")
content = content.replace("binanceCancelAlgoOrders", "bitgetCancelAlgoOrders")
content = content.replace("binanceCancelAlgoOrder", "bitgetCancelAlgoOrder")
content = content.replace("binanceGetPositions", "bitgetGetPositions")
content = content.replace("binanceGetPricePrecision", "bitgetGetPricePrecision")

with open('c:/PROYECTOS/binance1/lib/bitget.ts', 'w', encoding='utf-8') as f:
    f.write(content)

print("Updated lib/bitget.ts too!")

# Finally remove lib/binance.ts
if os.path.exists('c:/PROYECTOS/binance1/lib/binance.ts'):
    os.remove('c:/PROYECTOS/binance1/lib/binance.ts')

