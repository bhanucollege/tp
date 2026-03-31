const path = require('path');

// Test the escaping logic
function testEscape() {
    const testCases = [
        'data.csv',
        'train_model.py',
        'special$file.csv',
        'dots.in.name.csv',
        'brackets[test].csv'
    ];
    
    console.log('Testing CSV path escaping:\n');
    
    for (const fileName of testCases) {
        const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        console.log(`Original: ${fileName}`);
        console.log(`Escaped:  ${escaped}`);
        
        // Test that we can build a regex without error
        try {
            const regex = new RegExp(`'${escaped}'`, 'g');
            console.log(`✅ RegExp created successfully\n`);
        } catch (e) {
            console.log(`❌ RegExp error: ${e.message}\n`);
        }
    }
}

// Test actual path substitution
function testSubstitution() {
    console.log('\nTesting CSV path substitution:\n');
    
    const pythonCode = `
import pandas as pd
data = pd.read_csv('data.csv')
train = pd.read_csv('./train_model.csv')
other = pd.read_csv("test.csv")
path = "./data_2021.csv"
`;
    
    const csvFileName = 'data.csv';
    const baseName = path.basename(csvFileName);
    const escaped = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    
    let result = pythonCode;
    result = result.replace(new RegExp(`'${escaped}'`, 'g'), `'/app/${baseName}'`);
    result = result.replace(new RegExp(`"${escaped}"`, 'g'), `"/app/${baseName}"`);
    result = result.replace(new RegExp(`'\\.\/${escaped}'`, 'g'), `'/app/${baseName}'`);
    result = result.replace(new RegExp(`"\\.\\/${escaped}"`, 'g'), `"/app/${baseName}"`);
    
    console.log('Input Python code:');
    console.log(pythonCode);
    console.log('\nAfter CSV path substitution:');
    console.log(result);
    
    // Check if substitution worked
    if (result.includes("'/app/data.csv'")) {
        console.log('\n✅ CSV paths successfully substituted!');
    } else {
        console.log('\n❌ CSV paths were NOT substituted');
    }
}

testEscape();
testSubstitution();
