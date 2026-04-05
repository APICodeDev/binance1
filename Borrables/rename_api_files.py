import os
import glob
import shutil

# First make sure lib/bitget.ts has the latest logic
shutil.copy2('c:/PROYECTOS/BITGET1/lib/BITGET.ts', 'c:/PROYECTOS/BITGET1/lib/bitget.ts')

# Now search all .ts files in app/api and replace BITGET with bitget
pattern = 'c:/PROYECTOS/BITGET1/app/api/**/*.ts'
files = glob.glob(pattern, recursive=True)

for file in files:
    with open(file, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # replace the import path
    content = content.replace("@/lib/BITGET", "@/lib/bitget")
    # replace function signatures
    content = content.replace("BITGETGetPrice", "bitgetGetPrice")
    content = content.replace("BITGETPlaceMarketOrder", "bitgetPlaceMarketOrder")
    content = content.replace("BITGETPlaceStopMarket", "bitgetPlaceStopMarket")
    content = content.replace("BITGETOrderSuccess", "bitgetOrderSuccess")
    content = content.replace("BITGETClosePosition", "bitgetClosePosition")
    content = content.replace("BITGETCancelAllOrders", "bitgetCancelAllOrders")
    content = content.replace("BITGETGetExchangeInfo", "bitgetGetExchangeInfo")
    content = content.replace("BITGETGetCommissionRate", "bitgetGetCommissionRate")
    content = content.replace("BITGETNormalizeSymbol", "bitgetNormalizeSymbol")
    content = content.replace("BITGETGetPositions", "bitgetGetPositions")

    with open(file, 'w', encoding='utf-8') as f:
        f.write(content)

print("Updated all routes!")

# Update lib/bitget.ts itself to also rename the exported functions
with open('c:/PROYECTOS/BITGET1/lib/bitget.ts', 'r', encoding='utf-8') as f:
    content = f.read()

content = content.replace("BITGETGetPrice", "bitgetGetPrice")
content = content.replace("BITGETPlaceMarketOrder", "bitgetPlaceMarketOrder")
content = content.replace("BITGETPlaceStopMarket", "bitgetPlaceStopMarket")
content = content.replace("BITGETOrderSuccess", "bitgetOrderSuccess")
content = content.replace("BITGETClosePosition", "bitgetClosePosition")
content = content.replace("BITGETCancelAllOrders", "bitgetCancelAllOrders")
content = content.replace("BITGETGetExchangeInfo", "bitgetGetExchangeInfo")
content = content.replace("BITGETGetCommissionRate", "bitgetGetCommissionRate")
content = content.replace("BITGETNormalizeSymbol", "bitgetNormalizeSymbol")
content = content.replace("BITGETCancelAlgoOrders", "bitgetCancelAlgoOrders")
content = content.replace("BITGETCancelAlgoOrder", "bitgetCancelAlgoOrder")
content = content.replace("BITGETGetPositions", "bitgetGetPositions")
content = content.replace("BITGETGetPricePrecision", "bitgetGetPricePrecision")

with open('c:/PROYECTOS/BITGET1/lib/bitget.ts', 'w', encoding='utf-8') as f:
    f.write(content)

print("Updated lib/bitget.ts too!")

# Finally remove lib/BITGET.ts
if os.path.exists('c:/PROYECTOS/BITGET1/lib/BITGET.ts'):
    os.remove('c:/PROYECTOS/BITGET1/lib/BITGET.ts')


