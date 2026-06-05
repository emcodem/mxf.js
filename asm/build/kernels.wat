(module
 (type $0 (func (result i32)))
 (type $1 (func))
 (memory $0 1)
 (export "idctSrcPtr" (func $asm/kernels/idctSrcPtr))
 (export "idctDstPtr" (func $asm/kernels/idctDstPtr))
 (export "idct" (func $asm/kernels/idct))
 (export "memory" (memory $0))
 (func $asm/kernels/idctSrcPtr (result i32)
  i32.const 1024
 )
 (func $asm/kernels/idctDstPtr (result i32)
  i32.const 1280
 )
 (func $asm/kernels/idct
  (local $0 i32)
  (local $1 i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  (local $5 i32)
  (local $6 i32)
  (local $7 i32)
  (local $8 i32)
  (local $9 i32)
  (local $10 i32)
  (local $11 i32)
  (local $12 i32)
  (local $13 i32)
  (local $14 i32)
  (local $15 i32)
  (local $16 i32)
  (local $17 i32)
  (local $18 i32)
  (local $19 i32)
  (local $20 i32)
  loop $for-loop|0
   local.get $0
   i32.const 8
   i32.lt_s
   if
    local.get $0
    i32.const 2
    i32.shl
    local.tee $1
    i32.const 1024
    i32.add
    i32.load
    local.set $2
    local.get $1
    i32.const 1088
    i32.add
    i32.load
    local.tee $3
    local.get $1
    i32.const 1216
    i32.add
    i32.load
    local.tee $4
    i32.add
    local.set $5
    local.get $2
    local.get $1
    i32.const 1152
    i32.add
    i32.load
    local.tee $6
    i32.sub
    local.tee $7
    local.get $3
    local.get $4
    i32.sub
    i32.const 362
    i32.mul
    i32.const 128
    i32.add
    i32.const 8
    i32.shr_s
    local.get $5
    i32.sub
    local.tee $3
    i32.add
    local.set $4
    i32.const 0
    local.get $1
    i32.const 1056
    i32.add
    i32.load
    local.tee $8
    local.get $1
    i32.const 1248
    i32.add
    i32.load
    local.tee $9
    i32.sub
    local.tee $10
    i32.const 473
    i32.mul
    local.get $1
    i32.const 1184
    i32.add
    i32.load
    local.tee $11
    local.get $1
    i32.const 1120
    i32.add
    i32.load
    local.tee $12
    i32.sub
    local.tee $13
    i32.const 196
    i32.mul
    i32.sub
    i32.const 128
    i32.add
    i32.const 8
    i32.shr_s
    local.get $8
    local.get $9
    i32.add
    local.tee $8
    local.get $11
    local.get $12
    i32.add
    local.tee $9
    i32.add
    local.tee $11
    i32.sub
    local.tee $12
    local.get $8
    local.get $9
    i32.sub
    i32.const 362
    i32.mul
    i32.const 128
    i32.add
    i32.const 8
    i32.shr_s
    i32.sub
    local.tee $8
    i32.sub
    local.get $13
    i32.const 473
    i32.mul
    local.get $10
    i32.const 196
    i32.mul
    i32.add
    i32.const 128
    i32.add
    i32.const 8
    i32.shr_s
    i32.sub
    local.set $9
    local.get $1
    i32.const 1280
    i32.add
    local.get $2
    local.get $6
    i32.add
    local.tee $2
    local.get $5
    i32.add
    local.tee $6
    local.get $11
    i32.add
    i32.store
    local.get $1
    i32.const 1312
    i32.add
    local.get $4
    local.get $12
    i32.add
    i32.store
    local.get $1
    i32.const 1344
    i32.add
    local.get $7
    local.get $3
    i32.sub
    local.tee $3
    local.get $8
    i32.sub
    i32.store
    local.get $1
    i32.const 1376
    i32.add
    local.get $2
    local.get $5
    i32.sub
    local.tee $2
    local.get $9
    i32.sub
    i32.store
    local.get $1
    i32.const 1408
    i32.add
    local.get $2
    local.get $9
    i32.add
    i32.store
    local.get $1
    i32.const 1440
    i32.add
    local.get $3
    local.get $8
    i32.add
    i32.store
    local.get $1
    i32.const 1472
    i32.add
    local.get $4
    local.get $12
    i32.sub
    i32.store
    local.get $1
    i32.const 1504
    i32.add
    local.get $6
    local.get $11
    i32.sub
    i32.store
    local.get $0
    i32.const 1
    i32.add
    local.set $0
    br $for-loop|0
   end
  end
  i32.const 0
  local.set $0
  loop $for-loop|1
   local.get $0
   i32.const 64
   i32.lt_s
   if
    local.get $0
    i32.const 2
    i32.shl
    local.tee $4
    i32.const 1280
    i32.add
    local.tee $5
    i32.load
    local.set $6
    local.get $4
    i32.const 1288
    i32.add
    local.tee $7
    i32.load
    local.tee $1
    local.get $4
    i32.const 1304
    i32.add
    local.tee $8
    i32.load
    local.tee $2
    i32.add
    local.set $9
    local.get $6
    local.get $4
    i32.const 1296
    i32.add
    local.tee $10
    i32.load
    local.tee $11
    i32.sub
    local.tee $12
    local.get $1
    local.get $2
    i32.sub
    i32.const 362
    i32.mul
    i32.const 128
    i32.add
    i32.const 8
    i32.shr_s
    local.get $9
    i32.sub
    local.tee $13
    i32.add
    local.set $1
    i32.const 0
    local.get $4
    i32.const 1284
    i32.add
    local.tee $2
    i32.load
    local.tee $14
    local.get $4
    i32.const 1308
    i32.add
    local.tee $15
    i32.load
    local.tee $16
    i32.sub
    local.tee $3
    i32.const 473
    i32.mul
    local.get $4
    i32.const 1300
    i32.add
    local.tee $17
    i32.load
    local.tee $18
    local.get $4
    i32.const 1292
    i32.add
    local.tee $4
    i32.load
    local.tee $19
    i32.sub
    local.tee $20
    i32.const 196
    i32.mul
    i32.sub
    i32.const 128
    i32.add
    i32.const 8
    i32.shr_s
    local.get $14
    local.get $16
    i32.add
    local.tee $14
    local.get $18
    local.get $19
    i32.add
    local.tee $16
    i32.add
    local.tee $18
    i32.sub
    local.tee $19
    local.get $14
    local.get $16
    i32.sub
    i32.const 362
    i32.mul
    i32.const 128
    i32.add
    i32.const 8
    i32.shr_s
    i32.sub
    local.tee $14
    i32.sub
    local.get $20
    i32.const 473
    i32.mul
    local.get $3
    i32.const 196
    i32.mul
    i32.add
    i32.const 128
    i32.add
    i32.const 8
    i32.shr_s
    i32.sub
    local.set $3
    local.get $5
    local.get $6
    local.get $11
    i32.add
    local.tee $5
    local.get $9
    i32.add
    local.tee $6
    local.get $18
    i32.add
    i32.const 128
    i32.add
    i32.const 8
    i32.shr_s
    i32.store
    local.get $2
    local.get $1
    local.get $19
    i32.add
    i32.const 128
    i32.add
    i32.const 8
    i32.shr_s
    i32.store
    local.get $7
    local.get $12
    local.get $13
    i32.sub
    local.tee $2
    local.get $14
    i32.sub
    i32.const 128
    i32.add
    i32.const 8
    i32.shr_s
    i32.store
    local.get $4
    local.get $5
    local.get $9
    i32.sub
    local.tee $4
    local.get $3
    i32.sub
    i32.const 128
    i32.add
    i32.const 8
    i32.shr_s
    i32.store
    local.get $10
    local.get $3
    local.get $4
    i32.add
    i32.const 128
    i32.add
    i32.const 8
    i32.shr_s
    i32.store
    local.get $17
    local.get $2
    local.get $14
    i32.add
    i32.const 128
    i32.add
    i32.const 8
    i32.shr_s
    i32.store
    local.get $8
    local.get $1
    local.get $19
    i32.sub
    i32.const 128
    i32.add
    i32.const 8
    i32.shr_s
    i32.store
    local.get $15
    local.get $6
    local.get $18
    i32.sub
    i32.const 128
    i32.add
    i32.const 8
    i32.shr_s
    i32.store
    local.get $0
    i32.const 8
    i32.add
    local.set $0
    br $for-loop|1
   end
  end
 )
)
