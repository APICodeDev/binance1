import os

def replace_in_file(filepath):
    if not os.path.exists(filepath):
        print(f"{filepath} not found")
        return
        
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    # Change text from KRAKEN to Kraken just in case and colors to a neon cyan theme
    content = content.replace('KRAKEN', 'KRAKEN')
    content = content.replace('KRAKEN', 'Kraken')
    content = content.replace('yellow-400', 'cyan-400')
    content = content.replace('yellow-300', 'cyan-300')
    
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)

replace_in_file('c:/PROYECTOS/KRAKEN1/app/page.tsx')
replace_in_file('c:/PROYECTOS/KRAKEN1/app/layout.tsx')

print("Replacement complete.")

