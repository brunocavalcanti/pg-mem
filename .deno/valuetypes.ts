import { IValue, _IIndex, _ISelection, _IType, _Transaction, _Explainer, _ExprExplanation } from './interfaces-private.ts';
import { DataType, QueryError, CastError, nil } from './interfaces.ts';
import hash from 'https://deno.land/x/object_hash@2.0.3.1/mod.ts';
import { Types, makeArray, makeType, ArrayType, isNumeric } from './datatypes.ts';
import { buildCall } from './functions.ts';
import { nullIsh } from './utils.ts';


let convDepth = 0;

export class Evaluator<T = any> implements IValue<T> {

    readonly isConstantLiteral: boolean;
    readonly usedColumns = new Set<IValue>();
    readonly forceNotConstant?: boolean;

    get index(): _IIndex | nil {
        return this.origin?.getIndex(this);
    }

    get isConstant(): boolean {
        return !this.usedColumns.size && !this.forceNotConstant;
    }

    get isConstantReal(): boolean {
        return typeof this.val !== 'function';
    }

    origin: _ISelection | nil;

    get isAny(): boolean {
        return this.opts?.isAny ?? false;
    }

    constructor(
        readonly type: _IType<T>
        , readonly id: string | nil
        , readonly sql: string | nil
        , readonly hash: string
        , dependencies: IValue | IValue[] | nil
        , public val: nil | Object | number | string | Date | ((raw: any, transaction: _Transaction | nil, isResult: boolean) => any)
        , private opts?: {
            isAny?: boolean;
            isColumnOf?: _ISelection;
            forceNotConstant?: boolean;
            unpure?: boolean;
        }) {
        this.isConstantLiteral = typeof val !== 'function';
        if (opts?.forceNotConstant) {
            this.forceNotConstant = true;
        }

        // fetch columns to depend on
        let depArray: IValue[] | undefined = undefined;
        let hasNotConstant = false;
        if (dependencies) {
            if (!Array.isArray(dependencies)) {
                depArray = [dependencies];
                this.usedColumns = dependencies.usedColumns as Set<IValue>;
                hasNotConstant = !dependencies.isConstant;
                this.origin = dependencies.origin;
            } else {
                this.usedColumns = new Set();
                for (const d of dependencies) {
                    if (d.origin) {
                        if (this.origin && this.origin !== d.origin) {
                            throw new Error('You cannot evaluate an expression which coming from multiple origins');
                        }
                        this.origin = d.origin;
                    }
                    if (!d.isConstant) {
                        hasNotConstant = true;
                    }
                    for (const u of d.usedColumns) {
                        this.usedColumns.add(u);
                    }
                }
            }
        }

        if (opts?.isColumnOf) {
            this.usedColumns.add(this);
            this.origin = opts.isColumnOf;
            delete opts.isColumnOf;
        }
        if (hasNotConstant && !this.usedColumns.size) {
            this.forceNotConstant = true;
        }

        if (!this.usedColumns.size // no used columns
            && !this.origin
            && !this.opts?.unpure
            && !this.forceNotConstant
            && !depArray?.some(x => !x.isConstantReal)  // all real constant dependencies
        ) {
            // no dependency => this is a real constant => evaluate it.
            if (typeof this.val === 'function') {
                this.val = this.val(null, null, true);
            }
        }
    }

    setType(type: _IType) {
        if (this.type === type) {
            return this;
        }
        return new Evaluator<T>(
            type
            , this.id
            , this.sql
            , this.hash
            , this
            , this.val
            , this.opts
        );
    }



    setConversion(converter: (val: any, isResult: boolean) => any
        , sqlConv: (sql: string) => string
        , hashConv: (hash: string) => any) {
        return new Evaluator<T>(
            this.type
            , this.id
            , this.sql && sqlConv(this.sql)
            , hash(hashConv(this.hash))
            , this
            , (raw, t) => {
                let got = this.get(raw, t);
                if (got === null || got === undefined) {
                    return null;
                }
                if (!this.isAny) {
                    return converter(got, convDepth == 1);
                }
                if (!Array.isArray(got)) {
                    throw new QueryError('Unexpected use of ANY()');
                }
                return got.map(x => converter(x, convDepth === 1));
            }
            , this.opts
        );
    }

    setOrigin(origin: _ISelection): IValue<T> {
        const ret = this.clone();
        ret.origin = origin;
        return ret;
    }

    clone(): Evaluator<T> {
        return new Evaluator<T>(
            this.type
            , this.id
            , this.sql
            , this.hash
            , this
            , this.val
            , this.opts
        );
    }


    setWrapper(newOrigin: _ISelection, unwrap: (val: any) => any): IValue<T> {
        if (this.isAny) {
            throw new QueryError('Unexpected use of ANY()');
        }
        const ret = new Evaluator<T>(
            this.type
            , this.id
            , this.sql
            , this.hash
            , this
            , (raw, t) => {
                const got = unwrap(raw)
                if (got === null || got === undefined) {
                    return null;
                }
                return this.get(got, t);
            }
            , this.opts
        );
        ret.origin = newOrigin;
        return ret;
    }

    setId(newId: string): IValue {
        if (this.id === newId) {
            return this;
        }
        return new Evaluator<T>(
            this.type
            , newId
            , this.sql
            , this.hash
            , this
            , this.val
            , this.opts
        );
    }

    get(): T;
    get(raw: any, t: _Transaction | nil): T;
    get(raw?: any, t?: _Transaction): T {
        if ((nullIsh(raw) || !t) && !this.isConstant) {
            throw new Error('Cannot be evaluated as constant');
        }
        return this._get(raw, t);
    }

    private _get(raw?: any, t?: _Transaction): T {
        if (typeof this.val !== 'function') {
            return this.val as any;
        }

        try {
            convDepth++;
            return this.val(raw, t, convDepth === 1);
        } finally {
            convDepth--;
        }
    }

    canConvert(to: DataType | _IType<T>): boolean {
        return !!this.type.canConvert(to);
    }

    convert<T = any>(to: DataType | _IType<T>): IValue<T> {
        return this.type.convert(this, to);
    }

    toString() {
        return this.sql;
    }

    explain(e: _Explainer): _ExprExplanation {
        if (!this.origin) {
            return {
                constant: true,
            }
        }
        return {
            on: e.idFor(this.origin),
            col: this.id ?? this.sql!,
        };
    }
}

// export class ArrayEvaluator<T> implements IValue {

//     constructor(
//         readonly type: _IType<T>
//         , readonly id: string
//         , readonly sql: string
//         , readonly hash: string
//         , readonly selection: _ISelection
//         , public val: T | ((raw: any) => T)) {
//     }

//     get index() {
//         return this.selection?.getIndex(this);
//     }

//     get isConstant(): boolean {
//         return typeof this.val !== 'function';
//     }

//     get(raw: any): T {
//         if (typeof this.val !== 'function') {
//             return this.val;
//         }
//         return (this.val as ((raw: any) => T))(raw);
//     }

//     asConstant(perform = true) {
//         if (!perform || typeof this.val !== 'function') {
//             return this;
//         }
//         return new Evaluator(this.type
//             , this.id
//             , this.sql
//             , this.hash
//             , this.selection
//             , this.get(null));
//     }


//     setId(newId: string): IValue {
//         if (this.id === newId) {
//             return this;
//         }
//         return new Evaluator<T>(
//             this.type
//             , newId
//             , this.sql
//             , this.hash
//             , this.selection
//             , this.val
//         );
//     }

//     canConvert(to: DataType | _IType<T>): boolean {
//         return this.type.canConvert(to);
//     }

//     convert<T = any>(to: DataType | _IType<T>): IValue<T> {
//         return this.type.convert(this, to);
//     }
// }


export const Value = {
    null(ofType?: _IType): IValue {
        return new Evaluator(ofType ?? Types.null, null, 'null', 'null', null, null, undefined);
    },
    text(value: string, length: number | nil = null): IValue {
        return new Evaluator(
            Types.text(length)
            , null
            , `[${value}]`
            , value
            , null
            , value);
    },
    number(value: number, type = Types.float): IValue {
        return new Evaluator(
            type
            , null
            , `[${value}]`
            , value.toString(10)
            , null
            , value);
    },
    function(value: string, args: IValue[]): IValue {
        return buildCall(value, args);
    },
    bool(value: boolean): IValue {
        const str = value ? 'true' : 'false';
        return new Evaluator(
            Types.bool
            , null
            , str
            , str
            , null
            , value);
    },
    /** @deprecated Use with care */
    constant(_type: DataType | _IType, value: any): IValue {
        const type = value === null ? Types.null : makeType(_type);
        return new Evaluator(type
            , null
            , null
            , (null as any)
            , null
            , value);
    },
    in(value: IValue, array: IValue, inclusive: boolean): IValue {
        if (!value) {
            throw new Error('Argument null');
        }
        if (array.type.primary !== DataType.array) {
            array = Value.array([array]);
        }
        const of = (array.type as ArrayType).of;
        return new Evaluator(
            Types.bool
            , null
            , value.sql + ' IN ' + array.sql
            , hash({ val: value.hash, in: array.hash })
            , [value, array]
            , (raw, t) => {
                const rawValue = value.get(raw, t);
                const rawArray = array.get(raw, t);
                if (!Array.isArray(rawArray)) {
                    return false;
                }
                const has = rawArray.some(x => of.equals(rawValue, x));
                return inclusive ? has : !has;
            });
    },
    isNull(leftValue: IValue, expectNull: boolean): IValue {
        return new Evaluator(
            Types.bool
            , null
            , `${leftValue.sql} IS${expectNull ? '' : ' NOT'} NULL`
            , hash({ isNull: leftValue.hash, expectNull })
            , leftValue
            , expectNull ? ((raw, t) => {
                const left = leftValue.get(raw, t);
                return left === null;
            }) : ((raw, t) => {
                const left = leftValue.get(raw, t);
                return left !== null && left !== undefined;
            }))
    },
    isTrue(leftValue: IValue, expectTrue: boolean): IValue {
        leftValue = leftValue.convert(Types.bool);
        return new Evaluator(
            Types.bool
            , null
            , `${leftValue.sql} IS${leftValue ? '' : ' NOT'} TRUE`
            , hash({ isTrue: leftValue.hash, expectTrue })
            , leftValue
            , expectTrue ? ((raw, t) => {
                const left = leftValue.get(raw, t);
                return left === true; // never returns null
            }) : ((raw, t) => {
                const left = leftValue.get(raw, t);
                return !(left === true); //  never returns null
            }));
    },
    isFalse(leftValue: IValue, expectFalse: boolean): IValue {
        leftValue = leftValue.convert(Types.bool);
        return new Evaluator(
            Types.bool
            , null
            , `${leftValue.sql} IS${leftValue ? '' : ' NOT'} FALSE`
            , hash({ isFalse: leftValue.hash, expectFalse })
            , leftValue
            , expectFalse ? ((raw, t) => {
                const left = leftValue.get(raw, t);
                return left === false; // never returns null
            }) : ((raw, t) => {
                const left = leftValue.get(raw, t);
                return !(left === false); //  never returns null
            }));
    },
    negate(value: IValue): IValue {
        if (value.type === Types.bool) {
            return (value as Evaluator)
                .setConversion(x => !x, x => 'NOT(' + x + ')', x => ({ not: x }));
        }
        if (!isNumeric(value.type)) {
            throw new QueryError('Can only apply "-" unary operator to numeric types');
        }
        return (value as Evaluator)
            .setConversion(x => -x, x => '-(' + x + ')', x => ({ neg: x }));
    },
    array(values: IValue[]): IValue {
        if (!values.length) {
            throw new QueryError('Expecting some value in list');
        }
        const type = values.reduce((t, v) => {
            if (v.canConvert(t)) {
                return t;
            }
            if (!t.canConvert(v.type)) {
                throw new CastError(t.primary, v.type.primary);
            }
            return v.type;
        }, Types.null);
        // const sel = values.find(x => !!x.selection)?.selection;
        const converted = values.map(x => x.convert(type));
        return new Evaluator(makeArray(type)
            , null
            , '(' + converted.map(x => x.sql).join(', ') + ')'
            , hash(converted.map(x => x.hash))
            , converted
            , (raw, t) => {
                const arr = values.map(x => x.get(raw, t));
                return arr;
            });
    }
} as const;