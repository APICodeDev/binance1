import os
import glob
import shutil

# First make sure lib/kraken.ts has the latest logic
shutil.copy2('c:/PROYECTOS/KRAKEN1/lib/KRAKEN.ts', 'c:/PROYECTOS/KRAKEN1/lib/kraken.ts')

# Now search all .ts files in app/api and replace KRAKEN with kraken
pattern = 'c:/PROYECTOS/KRAKEN1/app/api/**/*.ts'
files = glob.glob(pattern, recursive=True)

for file in files:
    with open(file, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # replace the import path
    content = content.replace("@/lib/KRAKEN", "@/lib/kraken")
    # replace function signatures
    content = content.replace("KRAKENGetPrice", "krakenGetPrice")
    content = content.replace("KRAKENPlaceMarketOrder", "krakenPlaceMarketOrder")
    content = content.replace("KRAKENPlaceStopMarket", "krakenPlaceStopMarket")
    content = content.replace("KRAKENOrderSuccess", "krakenOrderSuccess")
    content = content.replace("KRAKENClosePosition", "krakenClosePosition")
    content = content.replace("KRAKENCancelAllOrders", "krakenCancelAllOrders")
    content = content.replace("KRAKENGetExchangeInfo", "krakenGetExchangeInfo")
    content = content.replace("KRAKENGetCommissionRate", "krakenGetCommissionRate")
    content = content.replace("KRAKENNormalizeSymbol", "krakenNormalizeSymbol")
    content = content.replace("KRAKENGetPositions", "krakenGetPositions")

    with open(file, 'w', encoding='utf-8') as f:
        f.write(content)

print("Updated all routes!")

# Update lib/kraken.ts itself to also rename the exported functions
with open('c:/PROYECTOS/KRAKEN1/lib/kraken.ts', 'r', encoding='utf-8') as f:
    content = f.read()

content = content.replace("KRAKENGetPrice", "krakenGetPrice")
content = content.replace("KRAKENPlaceMarketOrder", "krakenPlaceMarketOrder")
content = content.replace("KRAKENPlaceStopMarket", "krakenPlaceStopMarket")
content = content.replace("KRAKENOrderSuccess", "krakenOrderSuccess")
content = content.replace("KRAKENClosePosition", "krakenClosePosition")
content = content.replace("KRAKENCancelAllOrders", "krakenCancelAllOrders")
content = content.replace("KRAKENGetExchangeInfo", "krakenGetExchangeInfo")
content = content.replace("KRAKENGetCommissionRate", "krakenGetCommissionRate")
content = content.replace("KRAKENNormalizeSymbol", "krakenNormalizeSymbol")
content = content.replace("KRAKENCancelAlgoOrders", "krakenCancelAlgoOrders")
content = content.replace("KRAKENCancelAlgoOrder", "krakenCancelAlgoOrder")
content = content.replace("KRAKENGetPositions", "krakenGetPositions")
content = content.replace("KRAKENGetPricePrecision", "krakenGetPricePrecision")

with open('c:/PROYECTOS/KRAKEN1/lib/kraken.ts', 'w', encoding='utf-8') as f:
    f.write(content)

print("Updated lib/kraken.ts too!")

# Finally remove lib/KRAKEN.ts
if os.path.exists('c:/PROYECTOS/KRAKEN1/lib/KRAKEN.ts'):
    os.remove('c:/PROYECTOS/KRAKEN1/lib/KRAKEN.ts')


