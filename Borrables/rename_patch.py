import glob

pattern = 'c:/PROYECTOS/BITGET1/app/api/**/*.ts'
files = glob.glob(pattern, recursive=True)

for file in files:
    with open(file, 'r', encoding='utf-8') as f:
        content = f.read()

    content = content.replace("BITGETCancelAlgoOrders", "bitgetCancelAlgoOrders")
    content = content.replace("BITGETCancelAlgoOrder", "bitgetCancelAlgoOrder")
    content = content.replace("BITGETGetPricePrecision", "bitgetGetPricePrecision")

    with open(file, 'w', encoding='utf-8') as f:
        f.write(content)

print("Fixed missing replacements.")

