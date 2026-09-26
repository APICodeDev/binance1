import glob

pattern = 'c:/PROYECTOS/KRAKEN1/app/api/**/*.ts'
files = glob.glob(pattern, recursive=True)

for file in files:
    with open(file, 'r', encoding='utf-8') as f:
        content = f.read()

    content = content.replace("KRAKENCancelAlgoOrders", "krakenCancelAlgoOrders")
    content = content.replace("KRAKENCancelAlgoOrder", "krakenCancelAlgoOrder")
    content = content.replace("KRAKENGetPricePrecision", "krakenGetPricePrecision")

    with open(file, 'w', encoding='utf-8') as f:
        f.write(content)

print("Fixed missing replacements.")

