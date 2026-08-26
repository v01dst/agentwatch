const [first, second] = process.argv.slice(2);
if (first === undefined || second === undefined) process.exit(1);
console.log(Number(first) + Number(second));
